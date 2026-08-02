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
