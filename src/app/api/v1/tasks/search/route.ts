import { db } from "@/lib/db/client";
import { tasks, categories, users, taskClaims } from "@/lib/db/schema";
import { eq, sql, count, and, gte, lte, desc } from "drizzle-orm";
import { withAgentAuth } from "@/lib/api/handler";
import { successResponse } from "@/lib/api/envelope";
import { invalidParameterError } from "@/lib/api/errors";

export const GET = withAgentAuth(async (request, _agent, _rateLimit) => {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limitNum = Math.min(Math.max(1, isNaN(limitRaw) ? 20 : limitRaw), 100);
  const minBudget = url.searchParams.get("min_budget");
  const maxBudget = url.searchParams.get("max_budget");
  const category = url.searchParams.get("category");

  if (!q || q.trim().length < 2) {
    return invalidParameterError(
      "Search query 'q' is required and must be at least 2 characters",
      "Include ?q=<search-term> in the request, e.g. GET /api/v1/tasks/search?q=python"
    );
  }

  // Build WHERE conditions for full-text search using PostgreSQL ts_vector
  const searchTerm = q.trim();

  // Use PostgreSQL full-text search for ranked results
  const conditions = [
    sql`(
      to_tsvector('english', ${tasks.title} || ' ' || ${tasks.description}) @@
      plainto_tsquery('english', ${searchTerm})
      OR ${tasks.title} ILIKE ${`%${searchTerm}%`}
      OR ${tasks.description} ILIKE ${`%${searchTerm}%`}
    )`,
    // Only search open tasks by default (agents browse to claim)
    sql`${tasks.status} = 'open'`,
  ];

  if (minBudget) {
    const min = Number(minBudget);
    if (!isNaN(min)) conditions.push(gte(tasks.budgetCredits, min));
  }
  if (maxBudget) {
    const max = Number(maxBudget);
    if (!isNaN(max)) conditions.push(lte(tasks.budgetCredits, max));
  }
  if (category) {
    const cat = Number(category);
    if (!isNaN(cat)) conditions.push(eq(tasks.categoryId, cat));
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      budgetCredits: tasks.budgetCredits,
      categoryId: tasks.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      status: tasks.status,
      posterId: users.id,
      posterName: users.name,
      deadline: tasks.deadline,
      maxRevisions: tasks.maxRevisions,
      createdAt: tasks.createdAt,
      // Rank results: exact title match > ts_rank > newest
      rank: sql<number>`
        CASE WHEN ${tasks.title} ILIKE ${`%${searchTerm}%`} THEN 2 ELSE 0 END
        + ts_rank(
            to_tsvector('english', ${tasks.title} || ' ' || ${tasks.description}),
            plainto_tsquery('english', ${searchTerm})
          )
      `,
    })
    .from(tasks)
    .leftJoin(categories, eq(tasks.categoryId, categories.id))
    .innerJoin(users, eq(tasks.posterId, users.id))
    .where(and(...conditions))
    .orderBy(
      desc(sql`
        CASE WHEN ${tasks.title} ILIKE ${`%${searchTerm}%`} THEN 2 ELSE 0 END
        + ts_rank(
            to_tsvector('english', ${tasks.title} || ' ' || ${tasks.description}),
            plainto_tsquery('english', ${searchTerm})
          )
      `)
    )
    .limit(limitNum);

  // Get claims counts for all tasks in this page
  const taskIds = rows.map((r) => r.id);
  let claimsCounts: Record<number, number> = {};
  if (taskIds.length > 0) {
    const countsResult = await db
      .select({
        taskId: taskClaims.taskId,
        count: count(),
      })
      .from(taskClaims)
      .where(
        sql`${taskClaims.taskId} IN (${sql.join(
          taskIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
      .groupBy(taskClaims.taskId);

    claimsCounts = Object.fromEntries(
      countsResult.map((r) => [r.taskId, Number(r.count)])
    );
  }

  const data = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    budget_credits: row.budgetCredits,
    category: row.categoryId
      ? { id: row.categoryId, name: row.categoryName, slug: row.categorySlug }
      : null,
    status: row.status,
    poster: { id: row.posterId, name: row.posterName },
    claims_count: claimsCounts[row.id] || 0,
    deadline: row.deadline?.toISOString() || null,
    max_revisions: row.maxRevisions,
    created_at: row.createdAt.toISOString(),
    relevance_score: row.rank,
  }));

  return successResponse(data, 200, {
    cursor: null,
    has_more: false,
    count: data.length,
  });
});
