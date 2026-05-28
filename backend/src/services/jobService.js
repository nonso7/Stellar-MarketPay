/**
 * src/services/jobService.js
 * Service responsibility: Manages job listings, including creation, retrieval, searching, status updates, freelancer assignment, escrow integration, and visibility boosting.
 * All data persisted in the `jobs` PostgreSQL table.
 */
"use strict";

const pool = require("../db/pool");
const { getTimezoneOffset } = require("date-fns-tz");
const { isBlocked } = require("./profileService");

/**
 * Camel-cased job record returned by this service.
 *
 * @typedef {Object} Job
 * @property {string}   id                  UUID of the job.
 * @property {string}   title               Job title (≥10 chars).
 * @property {string}   description         Job description (≥30 chars).
 * @property {string}   budget              Budget as a fixed-point string (e.g. "500.0000000").
 * @property {("XLM"|"USDC")} currency      Payment currency.
 * @property {string}   category            One of {@link VALID_CATEGORIES}.
 * @property {("public"|"private"|"invite_only")} visibility
 * @property {string[]} skills              Up to 8 skill tags.
 * @property {("open"|"in_progress"|"completed"|"cancelled")} status
 * @property {string}   clientAddress       Stellar G-address of the client.
 * @property {string|null} freelancerAddress Stellar G-address of the hired freelancer, if any.
 * @property {string|null} escrowContractId Soroban contract id for the locked escrow.
 * @property {number}   applicantCount      Cached count of applications for this job.
 * @property {number}   shareCount          Number of times the job link has been shared.
 * @property {boolean}  boosted             True while the listing is Featured.
 * @property {string|null} boostedUntil     ISO timestamp at which boost expires.
 * @property {string|null} deadline         ISO timestamp deadline (optional).
 * @property {string|null} timezone         IANA timezone name for compatibility filtering.
 * @property {string[]} screeningQuestions  Up to 5 screening questions applicants must answer.
 * @property {string}   createdAt           ISO timestamp when the job was created.
 * @property {string}   updatedAt           ISO timestamp of last write.
 */

/**
 * Input shape accepted by {@link createJob}.
 *
 * @typedef {Object} CreateJobInput
 * @property {string}   title
 * @property {string}   description
 * @property {string|number} budget
 * @property {("XLM"|"USDC")} [currency="XLM"]
 * @property {string}   category
 * @property {string[]} [skills]
 * @property {string}   [deadline]            ISO timestamp.
 * @property {string}   [timezone]            IANA timezone name.
 * @property {string[]} [screeningQuestions]  Up to 5 questions; non-empty entries are kept.
 * @property {string}   clientAddress         Stellar G-address of the posting client.
 */

/**
 * Pagination wrapper returned by {@link listJobs}.
 *
 * @typedef {Object} JobListPage
 * @property {Job[]}      jobs
 * @property {string|null} nextCursor  Opaque base64 cursor for the next page, or null when exhausted.
 */

const VALID_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
  "disputed",
];

const VALID_CATEGORIES = [
  "Smart Contracts",
  "Frontend Development",
  "Backend Development",
  "UI/UX Design",
  "Technical Writing",
  "DevOps",
  "Security Audit",
  "Data Analysis",
  "Mobile Development",
  "Other",
];

/**
 * Throws a 400 Error when `key` is not a valid Stellar G-address.
 *
 * @param {string} key  Stellar account public key.
 * @returns {void}
 * @throws {Error}      `status === 400` if the key fails the G-address regex.
 */
function validatePublicKey(key) {
  if (!key || !/^G[A-Z0-9]{55}$/.test(key)) {
    const e = new Error("Invalid Stellar public key");
    e.status = 400;
    throw e;
  }
}

/**
 * Check if a job's timezone is compatible with the user's timezone.
 * Compatible if the time difference is within +/-3 hours.
 *
 * @param {string} jobTimezone - IANA timezone string of the job (e.g., "America/New_York")
 * @param {string} userTimezone - IANA timezone string of the user (e.g., "Europe/London")
 * @returns {boolean} true if timezones are compatible or if job has no timezone restriction
 */
function isTimezoneCompatible(jobTimezone, userTimezone) {
  if (!jobTimezone) return true;
  if (!userTimezone) return true;

  try {
    const now = new Date();
    const userOffset = getTimezoneOffset(userTimezone, now);
    const jobOffset = getTimezoneOffset(jobTimezone, now);

    // Calculate the absolute difference in hours
    const diffHours = Math.abs(userOffset - jobOffset) / (1000 * 60 * 60);

    // Return true if within ±3 hour range
    return diffHours <= 3;
  } catch {
    return true;
  }
}

/**
 * Convert a snake_case `jobs` row into the camelCase API object.
 *
 * @param {Object} row  Raw row from the `jobs` table.
 * @returns {Job}       Camel-cased job record.
 */
function rowToJob(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    budget: row.budget,
    currency: row.currency || "XLM",
    category: row.category,
    skills: row.skills,
    status: row.status,
    clientAddress: row.client_address,
    freelancerAddress: row.freelancer_address,
    escrowContractId: row.escrow_contract_id,
    applicantCount: row.applicant_count,
    shareCount: row.share_count || 0,
    boosted: row.boosted || false,
    boostedUntil: row.boosted_until,
    deadline: row.deadline,
    timezone: row.timezone,
    screeningQuestions: row.screening_questions || [],
    disputeReason: row.dispute_reason,
    disputeDescription: row.dispute_description,
    disputedBy: row.disputed_by,
    disputedAt: row.disputed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @typedef {Object} CreateJobInput
 * @property {string} title - The title of the job (min 10 characters).
 * @property {string} description - The detailed description of the job (min 30 characters).
 * @property {string|number} budget - The positive budget amount for the job.
 * @property {string} [currency='XLM'] - The currency, either 'XLM' or 'USDC'.
 * @property {string} category - The category of the job (must be a valid category).
 * @property {string[]} [skills] - Array of relevant skills (max 8).
 * @property {Date|string} [deadline] - The deadline for the job.
 * @property {string} clientAddress - The Stellar public key of the client.
 */

/**
 * Create a new job listing.
 * Note: client's profile row must already exist (FK constraint).
 *
 * @param {CreateJobInput} params - The parameters to create a job.
 * @returns {Promise<Object>} The created job object.
 * @throws {Error} If validation fails or client profile doesn't exist.
 *
 * @example
 * const newJob = await jobService.createJob({
 *   title: 'Build a Smart Contract',
 *   description: 'Need a developer to build a Soroban smart contract for an escrow service.',
 *   budget: 500,
 *   currency: 'USDC',
 *   category: 'Smart Contracts',
 *   skills: ['Soroban', 'Rust'],
 *   clientAddress: 'GBX...',
 * });
 */
async function createJob({
  title,
  description,
  budget,
  currency,
  category,
  skills,
  deadline,
  timezone,
  clientAddress,
  screeningQuestions,
}) {
  validatePublicKey(clientAddress);

  if (!title || title.length < 10) {
    const e = new Error("Title must be at least 10 characters");
    e.status = 400;
    throw e;
  }
  if (!description || description.length < 30) {
    const e = new Error("Description must be at least 30 characters");
    e.status = 400;
    throw e;
  }
  if (!budget || isNaN(parseFloat(budget)) || parseFloat(budget) <= 0) {
    const e = new Error("Budget must be a positive number");
    e.status = 400;
    throw e;
  }
  if (!currency || !["XLM", "USDC"].includes(currency)) {
    const e = new Error("Currency must be XLM or USDC");
    e.status = 400;
    throw e;
  }
  if (!VALID_CATEGORIES.includes(category)) {
    const e = new Error("Invalid category");
    e.status = 400;
    throw e;
  }
  if (!["public", "private", "invite_only"].includes(visibility)) {
    const e = new Error("Visibility must be public, private, or invite_only");
    e.status = 400;
    throw e;
  }

  const safeSkills = Array.isArray(skills) ? skills.slice(0, 8) : [];
  const safeScreeningQuestions = Array.isArray(screeningQuestions)
    ? screeningQuestions.slice(0, 5).filter((q) => q && q.trim().length > 0)
    : [];

  const { rows } = await pool.query(
    `
    INSERT INTO jobs
      (title, description, budget, currency, category, skills, status, client_address, deadline, timezone, screening_questions, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, NOW(), NOW())
    RETURNING *
    `,
    [
      title.trim(),
      description.trim(),
      parseFloat(budget).toFixed(7),
      currency || "XLM",
      category,
      safeSkills,
      clientAddress,
      deadline || null,
      timezone || null,
      safeScreeningQuestions,
    ],
  );

  return rowToJob(rows[0]);
}

/**
 * Retrieves a job by its ID.
 *
 * @param {number|string} id - The ID of the job to retrieve.
 * @returns {Promise<Object>} The job object.
 * @throws {Error} If the job is not found.
 */
async function getJob(id) {
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }
  return rowToJob(rows[0]);
}

/**
 * Encode a (createdAt, id) pair into an opaque base64 cursor.
 * Currently unused but kept for future pagination implementation.
 *
 * @param {Object} jobRow  Row containing `created_at` and `id`.
 * @returns {string}        Base64-encoded JSON cursor.
 */
// eslint-disable-next-line no-unused-vars
function encodeCursor(jobRow) {
  return Buffer.from(
    JSON.stringify({
      createdAt: jobRow.created_at,
      id: jobRow.id,
    }),
  ).toString("base64");
}

/**
 * Decode a base64 pagination cursor produced by {@link encodeCursor}.
 *
 * @param {string} cursor  Base64-encoded JSON cursor.
 * @returns {{ createdAt: string, id: string }}
 * @throws {Error} 400 — when the cursor cannot be parsed.
 */
function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    if (!decoded.createdAt || !decoded.id) throw new Error("Invalid cursor");
    return decoded;
  } catch (_) {
    const e = new Error("Invalid cursor");
    e.status = 400;
    throw e;
  }
}

/**
 * @typedef {Object} ListJobsOptions
 * @property {string} [category] - Filter by job category.
 * @property {string} [status='open'] - Filter by job status.
 * @property {number} [limit=50] - Max number of results to return (max 100).
 * @property {string} [search] - Search term for title, description, or skills.
 * @property {string} [cursor] - Pagination cursor.
 * @property {string} [timezone] - Filter by timezone.
 */

/**
 * List jobs with optional filtering, searching, and pagination.
 *
 * @param {ListJobsOptions} [options={}] - Options for listing jobs.
 * @returns {Promise<{jobs: Object[], nextCursor: string|null}>} An object containing the list of jobs and an optional next cursor for pagination.
 * @throws {Error} If the provided cursor is invalid.
 */
async function listJobs({
  category,
  status = "open",
  limit = 50,
  search,
  cursor,
  timezone,
} = {}) {
  const conditions = [];
  const params = [];

  if (status && status !== "all") {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  } else if (!includeExpired) {
    conditions.push("status != 'expired'");
  }

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(
      `(LOWER(title) LIKE $${idx} OR LOWER(description) LIKE $${idx} OR EXISTS (
         SELECT 1 FROM unnest(skills) s WHERE LOWER(s) LIKE $${idx}
       ))`,
    );
  }

  if (viewerAddress && /^G[A-Z0-9]{55}$/.test(viewerAddress)) {
    params.push(viewerAddress);
    const viewerIdx = params.length;
    conditions.push(
      `(visibility = 'public'
        OR client_address = $${viewerIdx}
        OR (visibility = 'invite_only' AND EXISTS (
          SELECT 1 FROM job_invitations ji
          WHERE ji.job_id = jobs.id AND ji.freelancer_address = $${viewerIdx}
        )))`,
    );
  } else {
    conditions.push("visibility = 'public'");
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    params.push(decoded.createdAt, decoded.id);
    const createdAtIdx = params.length - 1;
    const idIdx = params.length;
    conditions.push(
      `(created_at < $${createdAtIdx} OR (created_at = $${createdAtIdx} AND id < $${idIdx}))`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM jobs ${where} ORDER BY
       CASE WHEN boosted = true AND (boosted_until IS NULL OR boosted_until > NOW()) THEN 0 ELSE 1 END,
       created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );

  const jobs = rows.map(rowToJob);
  let nextCursor = null;

  if (rows.length === limit) {
    nextCursor = encodeCursor(rows[rows.length - 1]);
  }

  return { jobs, nextCursor };
}

/**
 * Retrieve all jobs posted by a specific client.
 *
 * @param {string} clientAddress - The Stellar public key of the client.
 * @returns {Promise<Object[]>} An array of job objects.
 * @throws {Error} If the clientAddress is an invalid Stellar public key.
 */
async function listJobsByClient(clientAddress) {
  validatePublicKey(clientAddress);
  const { rows } = await pool.query(
    "SELECT * FROM jobs WHERE client_address = $1 ORDER BY created_at DESC",
    [clientAddress],
  );
  return rows.map(rowToJob);
}

/**
 * Update the status of a specific job.
 *
 * @param {number|string} id - The ID of the job.
 * @param {string} status - The new status (must be one of VALID_STATUSES).
 * @returns {Promise<Object>} The updated job object.
 * @throws {Error} If the status is invalid or the job is not found.
 */
async function updateJobStatus(id, status) {
  if (!VALID_STATUSES.includes(status)) {
    const e = new Error("Invalid status");
    e.status = 400;
    throw e;
  }

  const { rows } = await pool.query(
    "UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [status, id],
  );

  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }

  return rowToJob(rows[0]);
}

/**
 * Assign a freelancer to a job and update its status to 'in_progress'.
 *
 * @param {number|string} jobId - The ID of the job.
 * @param {string} freelancerAddress - The Stellar public key of the freelancer.
 * @returns {Promise<Object>} The updated job object.
 * @throws {Error} If the freelancerAddress is invalid or the job is not found.
 */
async function assignFreelancer(jobId, freelancerAddress) {
  validatePublicKey(freelancerAddress);

  const { rows } = await pool.query(
    `UPDATE jobs
     SET freelancer_address = $1, status = 'in_progress', updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [freelancerAddress, jobId],
  );

  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }

  return rows.map(rowToJob);
}

/**
 * Update the escrow contract ID associated with a job.
 *
 * @param {number|string} jobId - The ID of the job.
 * @param {string} escrowContractId - The escrow contract ID.
 * @returns {Promise<Object>} The updated job object.
 * @throws {Error} If the escrowContractId is invalid or the job is not found.
 */
async function updateJobEscrowId(jobId, escrowContractId) {
  if (!escrowContractId || typeof escrowContractId !== "string") {
    const e = new Error("Invalid escrow contract ID");
    e.status = 400;
    throw e;
  }

  const { rows } = await pool.query(
    "UPDATE jobs SET escrow_contract_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [escrowContractId, jobId],
  );

  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }

  return rowToJob(rows[0]);
}

/**
 * Delete a job by its ID.
 *
 * @param {number|string} jobId - The ID of the job to delete.
 * @returns {Promise<void>} Resolves when the job is deleted.
 * @throws {Error} If the job is not found.
 */
async function deleteJob(jobId) {
  const { rowCount } = await pool.query("DELETE FROM jobs WHERE id = $1", [
    jobId,
  ]);
  if (!rowCount) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }
}

/**
 * Boost a job to increase its visibility for 7 days.
 *
 * @param {number|string} jobId - The ID of the job to boost.
 * @param {string} txHash - The transaction hash of the payment for boosting.
 * @returns {Promise<Object>} The updated job object.
 * @throws {Error} If the job is not found.
 */
async function boostJob(jobId, txHash) {
  // Verify job exists
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id = $1", [
    jobId,
  ]);
  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }

  const boostedUntil = new Date();
  boostedUntil.setDate(boostedUntil.getDate() + 7);

  const { rows: updateRows } = await pool.query(
    `UPDATE jobs
     SET boosted = true, boosted_until = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [boostedUntil.toISOString(), jobId],
  );

  return rowToJob(updateRows[0]);
}

/**
 * Increment the share count for a specific job.
 *
 * @param {number|string} jobId - The ID of the job.
 * @returns {Promise<Object>} The updated job object.
 * @throws {Error} If the job is not found.
 */
async function incrementShareCount(jobId) {
  const { rows } = await pool.query(
    "UPDATE jobs SET share_count = COALESCE(share_count, 0) + 1, updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId],
  );

  if (!rows.length) {
    const e = new Error("Job not found");
    e.status = 404;
    throw e;
  }

  return rowToJob(rows[0]);
}

async function raiseDispute(jobId, { reason, description, raisedBy }) {
  const { rows } = await query(
    `UPDATE jobs 
     SET status = 'disputed', 
         dispute_reason = $1, 
         dispute_description = $2, 
         disputed_by = $3, 
         disputed_at = NOW(), 
         updated_at = NOW() 
     WHERE id = $4 AND status = 'in_progress'
     RETURNING *`,
    [reason, description, raisedBy, jobId],
  );

  if (!rows.length) {
    const e = new Error("Job not found or not in progress");
    e.status = 404;
    throw e;
  }

  return rowToJob(rows[0]);
}

async function resolveDispute(jobId) {
  const { rows } = await query(
    `UPDATE jobs 
     SET status = 'in_progress', 
         dispute_reason = NULL, 
         dispute_description = NULL, 
         disputed_by = NULL, 
         disputed_at = NULL, 
         updated_at = NOW() 
     WHERE id = $1 AND status = 'disputed'
     RETURNING *`,
    [jobId],
  );

  if (!rows.length) {
    const e = new Error("Job not found or not disputed");
    e.status = 404;
    throw e;
  }

  return rowToJob(rows[0]);
}

async function getCategoryAnalytics() {
  const { rows } = await pool.query(`
    SELECT
      category,
      COUNT(*)                                                        AS job_count,
      AVG(budget)                                                     AS avg_budget_xlm,
      COUNT(*) FILTER (WHERE freelancer_address IS NOT NULL)          AS filled_count,
      AVG(
        EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0
      ) FILTER (WHERE freelancer_address IS NOT NULL)                 AS avg_days_to_fill
    FROM jobs
    GROUP BY category
    ORDER BY job_count DESC
  `);

  return rows.map((r) => ({
    category: r.category,
    jobCount: parseInt(r.job_count, 10),
    avgBudgetXLM: r.avg_budget_xlm
      ? parseFloat(parseFloat(r.avg_budget_xlm).toFixed(2))
      : 0,
    filledCount: parseInt(r.filled_count, 10),
    avgDaysToFill: r.avg_days_to_fill
      ? parseFloat(parseFloat(r.avg_days_to_fill).toFixed(1))
      : null,
  }));
}

async function getAnalyticsOverview() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                        AS total_jobs,
      COUNT(*) FILTER (WHERE status = 'open')                        AS open_jobs,
      COUNT(*) FILTER (WHERE status = 'in_progress')                 AS in_progress_jobs,
      COUNT(*) FILTER (WHERE status = 'completed')                   AS completed_jobs,
      AVG(budget)                                                     AS avg_budget_xlm,
      COUNT(*) FILTER (WHERE freelancer_address IS NOT NULL)          AS total_filled,
      AVG(
        EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0
      ) FILTER (WHERE freelancer_address IS NOT NULL)                 AS avg_days_to_fill
    FROM jobs
  `);

  const r = rows[0];
  return {
    totalJobs: parseInt(r.total_jobs, 10),
    openJobs: parseInt(r.open_jobs, 10),
    inProgressJobs: parseInt(r.in_progress_jobs, 10),
    completedJobs: parseInt(r.completed_jobs, 10),
    avgBudgetXLM: r.avg_budget_xlm
      ? parseFloat(parseFloat(r.avg_budget_xlm).toFixed(2))
      : 0,
    totalFilled: parseInt(r.total_filled, 10),
    avgDaysToFill: r.avg_days_to_fill
      ? parseFloat(parseFloat(r.avg_days_to_fill).toFixed(1))
      : null,
  };
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  listJobsByClient,
  updateJobStatus,
  assignFreelancer,
  updateJobEscrowId,
  deleteJob,
  boostJob,
  incrementShareCount,
  raiseDispute,
  resolveDispute,
  getCategoryAnalytics,
  getAnalyticsOverview,
  bulkCancelJobs,
  bulkExtendJobs,
  bulkBoostJobs,
};

/**
 * Cancel multiple jobs at once. Only cancels jobs that are 'open' and belong
 * to the requesting client. Returns a per-job result array.
 *
 * @param {string[]} jobIds          Array of job UUIDs to cancel.
 * @param {string}   clientAddress   Stellar G-address of the requesting client.
 * @returns {Promise<Array<{id: string, success: boolean, error?: string}>>}
 */
async function bulkCancelJobs(jobIds, clientAddress) {
  validatePublicKey(clientAddress);

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    const e = new Error("jobIds must be a non-empty array");
    e.status = 400;
    throw e;
  }
  if (jobIds.length > 50) {
    const e = new Error("Cannot bulk-cancel more than 50 jobs at once");
    e.status = 400;
    throw e;
  }

  // Fetch all requested jobs in one query
  const { rows } = await pool.query(
    `SELECT id, status, client_address FROM jobs WHERE id = ANY($1::uuid[])`,
    [jobIds],
  );

  const found = new Map(rows.map((r) => [r.id, r]));
  const results = [];

  for (const id of jobIds) {
    const job = found.get(id);
    if (!job) {
      results.push({ id, success: false, error: "Job not found" });
      continue;
    }
    if (job.client_address !== clientAddress) {
      results.push({ id, success: false, error: "Not your job" });
      continue;
    }
    if (job.status !== "open") {
      results.push({
        id,
        success: false,
        error: `Cannot cancel a job with status '${job.status}'`,
      });
      continue;
    }
    results.push({ id, success: true });
  }

  // Batch-update only the eligible ones
  const eligibleIds = results.filter((r) => r.success).map((r) => r.id);
  if (eligibleIds.length > 0) {
    await pool.query(
      `UPDATE jobs SET status = 'cancelled', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
      [eligibleIds],
    );
  }

  return results;
}

/**
 * Extend the expiry of multiple jobs at once. Only extends jobs that are
 * 'open' and belong to the requesting client.
 *
 * @param {string[]} jobIds          Array of job UUIDs to extend.
 * @param {string}   clientAddress   Stellar G-address of the requesting client.
 * @param {number}   [days=30]       Number of days to extend by (1–90).
 * @returns {Promise<Array<{id: string, success: boolean, newExpiresAt?: string, error?: string}>>}
 */
async function bulkExtendJobs(jobIds, clientAddress, days = 30) {
  validatePublicKey(clientAddress);

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    const e = new Error("jobIds must be a non-empty array");
    e.status = 400;
    throw e;
  }
  if (jobIds.length > 50) {
    const e = new Error("Cannot bulk-extend more than 50 jobs at once");
    e.status = 400;
    throw e;
  }
  const safeDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 90));

  const { rows } = await pool.query(
    `SELECT id, status, client_address, expires_at, extended_count FROM jobs WHERE id = ANY($1::uuid[])`,
    [jobIds],
  );

  const found = new Map(rows.map((r) => [r.id, r]));
  const results = [];

  for (const id of jobIds) {
    const job = found.get(id);
    if (!job) {
      results.push({ id, success: false, error: "Job not found" });
      continue;
    }
    if (job.client_address !== clientAddress) {
      results.push({ id, success: false, error: "Not your job" });
      continue;
    }
    if (!["open", "in_progress"].includes(job.status)) {
      results.push({
        id,
        success: false,
        error: `Cannot extend a job with status '${job.status}'`,
      });
      continue;
    }
    if ((job.extended_count || 0) >= 3) {
      results.push({
        id,
        success: false,
        error: "Maximum extensions (3) reached",
      });
      continue;
    }
    results.push({ id, success: true });
  }

  // Batch-update eligible jobs
  const eligibleIds = results.filter((r) => r.success).map((r) => r.id);
  if (eligibleIds.length > 0) {
    await pool.query(
      `UPDATE jobs
       SET
         expires_at      = COALESCE(expires_at, NOW()) + ($1 || ' days')::interval,
         extended_until  = COALESCE(expires_at, NOW()) + ($1 || ' days')::interval,
         extended_count  = COALESCE(extended_count, 0) + 1,
         updated_at      = NOW()
       WHERE id = ANY($2::uuid[])`,
      [safeDays, eligibleIds],
    );

    // Fetch updated expiry dates to return in results
    const { rows: updated } = await pool.query(
      `SELECT id, expires_at FROM jobs WHERE id = ANY($1::uuid[])`,
      [eligibleIds],
    );
    const expiryMap = new Map(updated.map((r) => [r.id, r.expires_at]));
    for (const r of results) {
      if (r.success) r.newExpiresAt = expiryMap.get(r.id) || null;
    }
  }

  return results;
}

/**
 * Boost multiple jobs at once. Only boosts jobs that are 'open' and belong
 * to the requesting client.
 *
 * @param {string[]} jobIds          Array of job UUIDs to boost.
 * @param {string}   clientAddress   Stellar G-address of the requesting client.
 * @param {string}   txHash          Payment transaction hash covering all boosts.
 * @returns {Promise<Array<{id: string, success: boolean, boostedUntil?: string, error?: string}>>}
 */
async function bulkBoostJobs(jobIds, clientAddress, txHash) {
  validatePublicKey(clientAddress);

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    const e = new Error("jobIds must be a non-empty array");
    e.status = 400;
    throw e;
  }
  if (jobIds.length > 20) {
    const e = new Error("Cannot bulk-boost more than 20 jobs at once");
    e.status = 400;
    throw e;
  }
  if (!txHash || typeof txHash !== "string") {
    const e = new Error("Transaction hash is required for bulk boost");
    e.status = 400;
    throw e;
  }

  const { rows } = await pool.query(
    `SELECT id, status, client_address FROM jobs WHERE id = ANY($1::uuid[])`,
    [jobIds],
  );

  const found = new Map(rows.map((r) => [r.id, r]));
  const results = [];

  for (const id of jobIds) {
    const job = found.get(id);
    if (!job) {
      results.push({ id, success: false, error: "Job not found" });
      continue;
    }
    if (job.client_address !== clientAddress) {
      results.push({ id, success: false, error: "Not your job" });
      continue;
    }
    if (job.status !== "open") {
      results.push({
        id,
        success: false,
        error: `Cannot boost a job with status '${job.status}'`,
      });
      continue;
    }
    results.push({ id, success: true });
  }

  const eligibleIds = results.filter((r) => r.success).map((r) => r.id);
  if (eligibleIds.length > 0) {
    const boostedUntil = new Date();
    boostedUntil.setDate(boostedUntil.getDate() + 7);

    await pool.query(
      `UPDATE jobs
       SET boosted = true, boosted_until = $1, updated_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [boostedUntil.toISOString(), eligibleIds],
    );

    for (const r of results) {
      if (r.success) r.boostedUntil = boostedUntil.toISOString();
    }
  }

  return results;
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  listJobsByClient,
  updateJobStatus,
  assignFreelancer,
  updateJobEscrowId,
  deleteJob,
  boostJob,
  incrementShareCount,
  raiseDispute,
  resolveDispute,
  getCategoryAnalytics,
  getAnalyticsOverview,
  bulkCancelJobs,
  bulkExtendJobs,
  bulkBoostJobs,
};
