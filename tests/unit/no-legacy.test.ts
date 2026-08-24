import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CRITICAL: These tests ensure no legacy patterns remain in campaign-service.
 * 
 * Context: We use brandIds (from brand-service) as the sole brand reference.
 * brandUrl was removed — downstream services resolve brand data via brand-service.
 */
describe('No Legacy Patterns - CRITICAL', () => {
  const srcDir = path.join(__dirname, '../../src');
  
  function getAllTsFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getAllTsFiles(fullPath));
      } else if (entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('should NOT carry a superseded-campaign concept anywhere in src', () => {
    // A campaign is never parked, deferred on a slow re-check loop, or held out of the running
    // because another campaign covers its funnel. Every alive campaign is re-ranked from scratch
    // every tick. The concept — and the word — must not come back.
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, index) => {
        if (/supersed/i.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: index + 1,
            code: line.trim().substring(0, 80),
          });
        }
      });
    }

    expect(
      violations,
      `A campaign is never superseded:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT read a goal off brand-service beyond the brand-level currentGoal', () => {
    // brand-service retired the goal set: the funnel is the only word it emits for what a brand
    // sells. Reading a goal off a DECLARED FUNNEL is what silently stopped every funnel campaign
    // being provisioned. The one goal-shaped read that survives anywhere is the brand's own
    // currentGoal on /runtime-context, and it is consulted ONLY for a campaign that states no
    // sales funnel — a feature that sells through none (PR, hiring, VC, AI-visibility).
    const client = fs.readFileSync(
      path.join(srcDir, 'lib/brand-sales-funnels-client.ts'),
      'utf-8',
    );
    const code = client
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/\bgoal\b/);
    expect(code).not.toMatch(/\bcurrentGoal\b/);
  });

  it('should NEVER resolve a campaign offer by BRAND alone', () => {
    // An offer belongs to the (org, brand) PAIR: a brand row is a shared global identity and
    // carries one offer per claiming org, frequently all named the same thing. Reading the brand's
    // offers without naming the org attributes this org's campaign to ANOTHER org's offer, inside
    // the very per-offer grouping the column exists to make correct. `x-org-id` on the read and
    // `org_id` on the write are load-bearing, not tracking.
    const client = fs.readFileSync(path.join(srcDir, 'lib/brand-offers-client.ts'), 'utf-8');
    expect(client).toMatch(/"x-org-id": identity\.orgId/);
    expect(client).not.toMatch(/if \(identity\.orgId\)/);

    const adoption = fs.readFileSync(path.join(srcDir, 'lib/campaign-offer-adoption.ts'), 'utf-8');
    // Every statement this rule makes about campaigns is scoped to the campaign's own org.
    const statements = adoption.split(/db\.execute/).slice(1);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/"org_id" = \$\{scope\.orgId\}/);
    }
    // And the offer is never derived from the funnel, the goal or the workflow.
    expect(adoption).not.toMatch(/funnelKey\s*[:=]/);
  });

  it('should NOT collapse a sales-funnels refusal back onto a nullable answer', () => {
    // The three outcomes — a truthful answer (possibly EMPTY), a refusal to answer at this grain,
    // and a transport failure — were one `null`, and that is what made the offer level silent: the
    // day a customer creates their second offer, brand-service refuses the brand-keyed read and the
    // brand simply looks like it declares no funnels. Returning a nullable array again reinstates
    // exactly that. The client returns a discriminated `SalesFunnelsRead` and nothing else.
    const client = fs.readFileSync(
      path.join(srcDir, 'lib/brand-sales-funnels-client.ts'),
      'utf-8',
    );
    const code = client
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/fetchDeclaredSalesFunnels/);
    expect(code).not.toMatch(/Promise<DeclaredSalesFunnel\[\] \| null>/);
    for (const fn of ['fetchOfferSalesFunnels', 'fetchBrandSalesFunnels']) {
      expect(code).toMatch(new RegExp(`${fn}[\\s\\S]{0,400}?Promise<SalesFunnelsRead>`));
    }
  });

  it('should NOT resolve a brand to ONE of its offers', () => {
    // Several offers of one brand are equals and none outranks another. Picking one would rank a
    // campaign on another product's economics and, across orgs, file one org's configuration onto
    // another org's campaign — inside the very per-offer grouping the column exists to make
    // correct. A campaign STATES its offer, or it has none.
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, index) => {
        const code = line.trimStart();
        if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return;
        if (/offerForBrand|resolveOfferForBrand|primaryOffer|defaultOffer|firstOffer/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: index + 1,
            code: line.trim().substring(0, 80),
          });
        }
      });
    }

    expect(
      violations,
      `A brand is never resolved to one of its offers:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT translate between a goal and a funnel anywhere in src', () => {
    // The goal was the poorer word (both meeting funnels collapse onto one `meetingBooked`) and it
    // was wrong at the source (brand-service's column carried a NOT NULL default). Both directions
    // of the translation are DELETED, not moved: a campaign STATES its funnel and every consumer
    // reads it there. A re-introduced map is how a brand whose goal names no funnel gets a live
    // campaign nobody can attribute — and, with the rule that used to gate on it, how a customer
    // funds a funnel and never gets a campaign for it.
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, index) => {
        const code = line.trimStart();
        if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return;
        if (/funnelForGoal|goalForFunnel|goalsWithAFunnel|resolveCampaignFunnelKey|readBrandGoal|FUNNEL_BY_GOAL|GOAL_BY_FUNNEL/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: index + 1,
            code: line.trim().substring(0, 80),
          });
        }
      });
    }

    expect(
      violations,
      `A goal is never translated to a funnel, or a funnel to a goal:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT write the goal column anywhere in src', () => {
    // The column is still SERVED (dashboard consumers migrate next) and scheduled for removal, but
    // nothing SETS it: a campaign says what it sells with its funnel. A write here would put a
    // second, poorer statement back on the row for a consumer to disagree with.
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; payload: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      // Every drizzle write payload in the file: `.values({ … })` / `.set({ … })`.
      for (const match of content.matchAll(/\.(values|set)\(\{/g)) {
        const start = match.index! + match[0].length - 1;
        let depth = 0;
        let end = start;
        for (; end < content.length; end++) {
          if (content[end] === '{') depth++;
          else if (content[end] === '}' && --depth === 0) break;
        }
        const payload = content.slice(start, end + 1);
        const code = payload
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
          .join('\n');
        if (/(^|[\s{,])goal\s*:/.test(code)) {
          violations.push({ file: path.relative(srcDir, file), payload: payload.slice(0, 120) });
        }
      }
    }

    expect(
      violations,
      `Nothing writes the goal column any more:\n${violations.map(v => `  ${v.file}\n    ${v.payload}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should still SERVE the stored goal — the column is scheduled for removal, not dropped here', () => {
    // The dashboard reads it on three surfaces and migrates next; dropping it from the wire now
    // takes those pages down.
    const schemas = fs.readFileSync(path.join(srcDir, 'schemas.ts'), 'utf-8');
    expect(schemas).toMatch(/goal: RuntimeGoalSchema\.nullable\(\)/);
    const dbSchema = fs.readFileSync(path.join(srcDir, 'db/schema.ts'), 'utf-8');
    expect(dbSchema).toMatch(/goal:\s*text\("goal"\)/);
  });

  it('should emit only the canonical funnel vocabulary from the funnel map', () => {
    // The pre-rename spellings are ACCEPTED forever on the way in (billing still sends them) and
    // never emitted. A canonical key is what gets stored and what a consumer reads.
    const vocab = fs.readFileSync(path.join(srcDir, 'lib/sales-funnel-vocabulary.ts'), 'utf-8');
    const canonical = vocab.slice(
      vocab.indexOf('export const SALES_FUNNEL_KEYS'),
      vocab.indexOf('const LEGACY_FUNNEL_KEYS'),
    );

    for (const preRename of ['visit_form', 'reply_meeting', 'visit_meeting', 'visit_signup']) {
      expect(canonical).not.toContain(preRename);
    }
  });

  it('should NOT have brandUrl query parameter filtering in routes', () => {
    const routesDir = path.join(srcDir, 'routes');
    const files = getAllTsFiles(routesDir);
    const violations: { file: string; line: number; code: string }[] = [];
    
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Check for brandUrl as query param for filtering
        if (
          (line.includes('req.query.brandUrl') || line.includes('query.brandUrl')) &&
          !line.includes('//')  // Ignore comments
        ) {
          violations.push({ 
            file: path.relative(srcDir, file), 
            line: index + 1,
            code: line.trim().substring(0, 80)
          });
        }
      });
    }
    
    expect(
      violations,
      `Routes still using brandUrl filtering:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}\n\nUse brandId filtering instead`
    ).toHaveLength(0);
  });

  it('should NOT have deprecated comments for brandId in worker data', () => {
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];
    
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes('deprecated') && line.toLowerCase().includes('brandid')) {
          violations.push({ 
            file: path.relative(srcDir, file), 
            line: index + 1,
            code: line.trim().substring(0, 80)
          });
        }
      });
    }
    
    expect(
      violations,
      `Files with deprecated brandId comments:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should have brandIds array column in schema', () => {
    const schemaFile = path.join(srcDir, 'db/schema.ts');
    const content = fs.readFileSync(schemaFile, 'utf-8');

    expect(content).toContain('brandIds');
    expect(content).toContain('brand_ids');
  });

  it('should NOT define orgs or users tables in schema', () => {
    const schemaFile = path.join(srcDir, 'db/schema.ts');
    const content = fs.readFileSync(schemaFile, 'utf-8');

    expect(content).not.toMatch(/export\s+const\s+orgs\b/);
    expect(content).not.toMatch(/export\s+const\s+users\b/);
    expect(content).not.toMatch(/pgTable\(\s*["']orgs["']/);
    expect(content).not.toMatch(/pgTable\(\s*["']users["']/);
  });

  it('should NOT have appId or keySource columns in schema', () => {
    const schemaFile = path.join(srcDir, 'db/schema.ts');
    const content = fs.readFileSync(schemaFile, 'utf-8');

    expect(content).not.toMatch(/appId\s*:/);
    expect(content).not.toMatch(/["']app_id["']/);
    expect(content).not.toMatch(/keySource\s*:/);
    expect(content).not.toMatch(/["']key_source["']/);
  });

  it('should NOT use Stripe subscription lifecycle calls', () => {
    const roots = [
      srcDir,
      path.join(__dirname, '../../packages'),
      path.join(__dirname, '../../scripts'),
    ].filter((dir) => fs.existsSync(dir));
    const violations: { file: string; line: number; code: string }[] = [];

    for (const root of roots) {
      const files = getAllTsFiles(root);
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          const lower = line.toLowerCase();
          if (lower.includes('stripe') || lower.includes('subscription')) {
            violations.push({
              file: path.relative(path.join(__dirname, '../..'), file),
              line: index + 1,
              code: line.trim().substring(0, 80),
            });
          }
        });
      }
    }

    expect(
      violations,
      `Campaign-service must not create/update/pause/cancel Stripe subscriptions:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT bring back the brand pause flag — funding is the one statement of held', () => {
    // `brand_pause.paused` was a second source of truth for a fact billing already states, and it
    // outlived its writer: the customer dashboard's pause control was deleted (a customer stops a
    // chain by defunding it), nothing in the fleet wrote the flag any more, and 27 brands sat
    // stored-paused with no API path back. A campaign is held when the customer funds nothing for
    // it, decided in ONE place (src/lib/campaign-funding.ts). The flag, its table and its helpers
    // must not come back — a second representation is what produced the contradiction.
    const roots = [srcDir, path.join(__dirname, '../../packages')].filter((d) => fs.existsSync(d));
    const violations: { file: string; line: number; code: string }[] = [];

    for (const root of roots) {
      for (const file of getAllTsFiles(root)) {
        const content = fs.readFileSync(file, 'utf-8');
        content.split('\n').forEach((line, index) => {
          if (/anyBrandPaused|notPausedBrandClause|\bbrandPause\b|["']brand_pause["']/.test(line)) {
            violations.push({
              file: path.relative(path.join(__dirname, '../..'), file),
              line: index + 1,
              code: line.trim().substring(0, 80),
            });
          }
        });
      }
    }

    expect(
      violations,
      `The brand pause flag is retired — a campaign is held by what the customer funds:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`
    ).toHaveLength(0);
  });

  it('should NOT mint a run id anywhere it crosses a service boundary', () => {
    // A minted uuid names a run that does not exist. workflow-service turns the x-run-id it is
    // given into the parentRunId of the run it creates, and runs.parent_run_id carries a foreign
    // key — so every execution of a campaign handed a minted id was refused before the DAG began,
    // while the campaign kept looking ongoing and freshly rescheduled (prod 2026-08-18: 3,593
    // refusals in six hours, a different id on every line). A campaign's ancestor run is
    // established ONCE, for real, in src/lib/trigger-run.ts.
    const guarded = [
      'lib/scheduler.ts',
      'lib/campaign-resume.ts',
      'lib/transactional-email.ts',
      'lib/provisioning-identity.ts',
    ];
    const violations: string[] = [];

    for (const rel of guarded) {
      const file = path.join(srcDir, rel);
      if (!fs.existsSync(file)) continue;
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, index) => {
        if (/randomUUID/.test(line)) violations.push(`src/${rel}:${index + 1}\n    ${line.trim()}`);
      });
    }

    expect(
      violations,
      `A run id handed to another service must be one runs-service can resolve — use ensureCampaignRunId:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });

  it('should NOT make the provisioning identity headers conditional', () => {
    // features-service and workflow-service REFUSE a read that does not state a full identity —
    // `400 Missing required headers: x-run-id` and `400 x-org-id, x-user-id, and x-run-id headers
    // are required` — whatever the caller happens to be doing. Both clients used to attach those
    // headers only when they happened to have them, and the provisioning path never did: every
    // read was rejected outright, every rejection became "unknown", and the whole per-channel
    // funding promise never worked once in production while saying nothing at all. Sending them
    // unconditionally is what makes the refusal impossible to reintroduce quietly.
    const guarded = ['lib/feature-sales-funnels-client.ts', 'lib/feature-workflow-client.ts'];
    const violations: string[] = [];

    for (const rel of guarded) {
      const content = fs.readFileSync(path.join(srcDir, rel), 'utf-8');
      content.split('\n').forEach((line, index) => {
        if (/if\s*\(identity\.(runId|userId|orgId)\)/.test(line)) {
          violations.push(`src/${rel}:${index + 1}\n    ${line.trim()}`);
        }
      });
      for (const header of ['x-org-id', 'x-user-id', 'x-run-id']) {
        if (!content.includes(`"${header}"`)) violations.push(`src/${rel} states no ${header}`);
      }
    }

    expect(
      violations,
      `A provisioning read states its full identity or it is refused:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });

  it('should NOT expose a writer for the brand held state on any surface', () => {
    // A brand-wide pause button beside per-funnel ceilings is the same contradiction wearing a
    // different hat. The held state is READ (GET /brands/:brandId/pause, derived from billing) and
    // written nowhere.
    const routesDir = path.join(srcDir, 'routes');
    const violations: string[] = [];
    for (const file of getAllTsFiles(routesDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, index) => {
        if (/router\.(patch|post|put)\(\s*["'][^"']*\/pause/.test(line)) {
          violations.push(`${path.relative(path.join(__dirname, '../..'), file)}:${index + 1}`);
        }
      });
    }
    expect(violations, `No route may write a brand pause state:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('should NOT hold which acquisition channel sells which sales funnel', () => {
    // A channel IS a feature slug, and which funnels a feature may be SOLD THROUGH is
    // features-service's product statement — asked per feature, never copied here. A second copy
    // drifts the day a channel gains or loses a chain, and the customer's money is on the outcome.
    // The one file allowed to name a funnel beside a feature slug is the one that ASKS.
    const files = getAllTsFiles(srcDir);
    const violations: { file: string; line: number; code: string }[] = [];

    for (const file of files) {
      const relative = path.relative(srcDir, file);
      if (relative === 'lib/feature-sales-funnels-client.ts') continue;
      const content = fs.readFileSync(file, 'utf-8');
      content.split('\n').forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        // A feature slug and a funnel key on the same line of CODE is a matrix being written down.
        if (/["'][a-z-]*sales-[a-z-]+["']/.test(code)
          && /["'](sales_meetings_from_\w+|website_purchases|form_magnet|reply_meeting|visit_\w+)["']/.test(code)) {
          violations.push({ file: relative, line: index + 1, code: line.trim().substring(0, 100) });
        }
      });
    }

    expect(
      violations,
      `Which feature sells through which funnel is features-service's statement — ask it:\n${violations.map(v => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n')}`,
    ).toHaveLength(0);
  });
});
