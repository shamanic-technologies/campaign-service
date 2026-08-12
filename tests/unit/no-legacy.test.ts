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
});
