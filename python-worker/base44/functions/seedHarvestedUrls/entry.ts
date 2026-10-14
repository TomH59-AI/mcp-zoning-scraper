// Bulk URL intake, not a second legal registry. Unmatched jurisdictions are
// returned for identity resolution, never manufactured from a name alone.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.53';
import { parseHarvest, planHarvest } from '../../shared/harvestedZoningUrls.ts';
import { clean, compareAndSetMaster } from '../../shared/railwayZoning.ts';
import { fillBlankPending } from '../../shared/masterPromotion.ts';

export default async function (req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 });
    const base44 = createClientFromRequest(req), user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin required' }, { status: 403 });
    const raw = await req.text();
    if (raw.length > 1000000) return Response.json({ error: 'Payload too large' }, { status: 413 });
    const body = JSON.parse(raw), items = parseHarvest(body), entity = base44.asServiceRole.entities.ZoningWorkbookReference;
    const rows: any[] = [];
    // Complete preflight before the first write. An unreadable page stops the
    // whole intake instead of treating the failed lookup as permission to create.
    for (const state of new Set(items.map(i => i.state))) {
      let skip = 0;
      while (true) {
        const page = await entity.filter({ state }, 'id', 200, skip);
        if (!Array.isArray(page)) throw new Error('Registry page read failed');
        rows.push(...page); skip += page.length;
        if (page.length < 200) break;
        if (skip > 20000) throw new Error('State page limit exceeded');
      }
    }
    const plan = planHarvest(items, rows), outcomes: any[] = [];
    if (body.commit === true) {
      const batch = crypto.randomUUID();
      for (const item of plan) {
        if (item.action !== 'fill_missing_url') { outcomes.push(item); continue; }
        const fresh = await entity.get(item.record_id);
        const check = planHarvest([item], [fresh])[0];
        if (check.action !== 'fill_missing_url') { outcomes.push(check); continue; }
        const decision = fillBlankPending(fresh, 3, { value: item.url, source_url: item.url,
          source_system: 'harvested_official_url', sources: [{ url: item.url, role: 'ordinance_url' }] }, user.email || user.id, batch);
        if (!decision.ok || !decision.patch) { outcomes.push({ ...item, action: 'needs_source_review', reasons: decision.reasons }); continue; }
        const saved = await compareAndSetMaster(entity, fresh, { ...decision.patch,
          ...(fresh.verification_status !== 'master_accepted' ? { field_release_policy: 'reviewed_fields_only' } : {}) });
        const confirmed = clean(saved.ordinance_url) === item.url;
        let historyWarning = false;
        if (confirmed && decision.history) {
          try { await base44.asServiceRole.entities.ZoningVersionHistory.create(decision.history); } catch { historyWarning = true; }
        }
        outcomes.push({ ...item, action: confirmed ? 'filled_pending_url' : 'concurrent_update', history_warning: historyWarning });
      }
    }
    return Response.json({ status: body.commit === true ? 'intake_complete' : 'dry_run', source_of_truth: 'ZoningWorkbookReference',
      created_records: 0, input_jurisdictions: items.length, outcomes: body.commit === true ? outcomes : plan,
      note: 'New or ambiguous identities require registry identity resolution. Existing populated URLs are preserved.' });
  } catch {
    return Response.json({ error: 'URL intake failed. Do not retry blindly; run a dry-run to reconcile any completed cells.' }, { status: 409 });
  }
}
