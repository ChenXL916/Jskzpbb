import { config } from 'dotenv';
import { join } from 'node:path';
import { Pool } from 'pg';

config({ path: join(process.cwd(), '../../.env') });

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const [
      setting,
      mappings,
      sessions,
      outbox,
      dataSources,
      activeRuleSets,
      coverage,
      anchorProfiles,
      roomEligibility,
      plans,
      latestPlans
    ] = await Promise.all([
      pool.query(
        "SELECT key, value FROM system_settings WHERE key='schedule.data_authority'"
      ),
      pool.query(
        `SELECT business_type, enabled, count(*)::int AS count
         FROM feishu_table_mappings
         GROUP BY business_type, enabled
         ORDER BY business_type, enabled`
      ),
      pool.query(
        `SELECT source_type, count(*)::int AS count,
                round(sum(extract(epoch FROM (ends_at-starts_at))/3600)::numeric,1)
                  AS hours
         FROM live_sessions
         WHERE starts_at >= '2026-07-31T16:00:00Z'
           AND starts_at < '2026-08-31T16:00:00Z'
           AND status='SCHEDULED' AND cancelled_at IS NULL
         GROUP BY source_type
         ORDER BY source_type`
      ),
      pool.query(
        `SELECT status, count(*)::int AS count
         FROM feishu_write_outbox
         GROUP BY status
         ORDER BY status`
      ),
      pool.query(
        `SELECT code, source_type, is_primary, enabled, read_only, status
         FROM scheduling_data_sources ORDER BY is_primary DESC, code`
      ),
      pool.query(
        `SELECT count(*)::int AS count
         FROM schedule_rule_sets WHERE status='ACTIVE'`
      ),
      pool.query(
        `SELECT count(DISTINCT template.id)::int AS template_count,
                count(slot.id)::int AS slot_count
         FROM room_coverage_templates template
         LEFT JOIN room_coverage_template_slots slot
           ON slot.template_id=template.id AND slot.enabled
         WHERE template.status='ACTIVE'`
      ),
      pool.query(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE eligible_for_auto_schedule)::int
                  AS auto_enabled_count
         FROM anchor_scheduling_profiles`
      ),
      pool.query(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE eligible)::int AS eligible_count
         FROM anchor_room_eligibility`
      ),
      pool.query(
        `SELECT schedule_month::text, status, strategy,
                count(*)::int AS count
         FROM monthly_schedule_plans
         GROUP BY schedule_month, status, strategy
         ORDER BY schedule_month DESC, status`
      ),
      pool.query(
        `SELECT plan.id, plan.schedule_month::text, plan.status, plan.strategy,
                plan.validation_summary, plan.generation_summary,
                count(assignment.id)::int AS assignment_count
         FROM monthly_schedule_plans plan
         LEFT JOIN monthly_schedule_assignments assignment
           ON assignment.plan_id=plan.id AND assignment.status<>'CANCELLED'
         GROUP BY plan.id
         ORDER BY plan.updated_at DESC
         LIMIT 5`
      )
    ]);
    process.stdout.write(
      `${JSON.stringify(
        {
          setting: setting.rows,
          mappings: mappings.rows,
          sessions: sessions.rows,
          outbox: outbox.rows,
          dataSources: dataSources.rows,
          activeRuleSets: activeRuleSets.rows,
          coverage: coverage.rows,
          anchorProfiles: anchorProfiles.rows,
          roomEligibility: roomEligibility.rows,
          plans: plans.rows,
          latestPlans: latestPlans.rows
        },
        null,
        2
      )}\n`
    );
  } finally {
    await pool.end();
  }
}

void main();
