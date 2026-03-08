/**
 * File Label Assignment — unit tests
 */

import { describe, it, expect } from 'vitest';
import { resolveFileLabel, quickFileLabel, labelByContent } from './file-labels.js';
import { dominates, isBottom } from './label.js';

describe('Extension-based labels (Layer 1)', () => {
  it('labels .pem as highly_confidential {credentials}', () => {
    const label = resolveFileLabel('/home/user/server.pem');
    expect(label.level).toBe(3);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('labels .key as highly_confidential {credentials}', () => {
    const label = resolveFileLabel('C:\\project\\cert.key');
    expect(label.level).toBe(3);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('labels .p12 as highly_confidential {credentials}', () => {
    const label = resolveFileLabel('/app/keystore.p12');
    expect(label.level).toBe(3);
  });

  it('labels .env as confidential {secrets, credentials}', () => {
    const label = resolveFileLabel('/project/.env');
    expect(label.level).toBe(2);
    expect(label.compartments.has('secrets')).toBe(true);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('labels .env.production as confidential', () => {
    const label = resolveFileLabel('/project/.env.production');
    expect(label.level).toBe(2);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('labels .md as public (BOTTOM)', () => {
    const label = resolveFileLabel('/project/README.md');
    expect(isBottom(label)).toBe(true);
  });

  it('labels .ts files as BOTTOM (no rule)', () => {
    const label = resolveFileLabel('/project/src/index.ts');
    expect(isBottom(label)).toBe(true);
  });
});

describe('Path-based labels (Layer 2)', () => {
  it('labels secrets/ directory as highly_confidential {secrets}', () => {
    const label = resolveFileLabel('/project/secrets/api-keys.json');
    expect(label.level).toBe(3);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('labels .ssh/ directory as highly_confidential {credentials}', () => {
    const label = resolveFileLabel('/home/user/.ssh/id_rsa');
    expect(label.level).toBe(3);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('labels deploy/ directory as confidential {internal_infra}', () => {
    const label = resolveFileLabel('/project/deploy/production.yml');
    expect(label.level).toBe(2);
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('labels terraform/ as confidential {internal_infra}', () => {
    const label = resolveFileLabel('/project/terraform/main.tf');
    expect(label.level).toBe(2);
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('labels k8s/ as confidential {internal_infra}', () => {
    const label = resolveFileLabel('/project/k8s/deployment.yaml');
    expect(label.level).toBe(2);
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('labels .github/workflows/ as internal {internal_infra}', () => {
    const label = resolveFileLabel('/project/.github/workflows/ci.yml');
    expect(label.level).toBe(1);
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('labels node_modules/ as BOTTOM', () => {
    const label = resolveFileLabel('/project/node_modules/lodash/index.js');
    expect(isBottom(label)).toBe(true);
  });
});

describe('Content-based labels (Layer 3)', () => {
  it('detects OpenAI API key in content', () => {
    const apiKey = ['sk', 'proj', 'abcdefghij1234567890abcdef'].join('-');
    const label = labelByContent(`const key = "${apiKey}"`);
    expect(label.level).toBe(3);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('detects AWS access key', () => {
    const label = labelByContent('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(label.level).toBe(3);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('detects private key header', () => {
    const label = labelByContent('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(label.level).toBe(3);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('detects JWT token', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('.');
    const label = labelByContent(`token: ${jwt}`);
    expect(label.level).toBeGreaterThanOrEqual(2);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('detects password assignments', () => {
    const label = labelByContent('password = "MySuperSecretPass123"');
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('detects SSN pattern', () => {
    const label = labelByContent('SSN: 123-45-6789');
    expect(label.compartments.has('pii')).toBe(true);
  });

  it('detects connection string', () => {
    const label = labelByContent('DATABASE_URL=postgres://admin:secret@db.internal:5432/mydb');
    expect(label.compartments.has('credentials')).toBe(true);
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('detects private IP addresses', () => {
    const label = labelByContent('server: 192.168.1.100');
    expect(label.compartments.has('internal_infra')).toBe(true);
  });

  it('returns BOTTOM for clean code', () => {
    const label = labelByContent('function hello() { return "world"; }');
    expect(isBottom(label)).toBe(true);
  });

  it('returns BOTTOM for empty content', () => {
    expect(isBottom(labelByContent(''))).toBe(true);
  });
});

describe('Combined resolution (all layers)', () => {
  it('joins extension + path labels', () => {
    // .env in secrets/ → join(confidential{secrets,credentials}, highly_confidential{secrets})
    const label = resolveFileLabel('/project/secrets/.env');
    expect(label.level).toBe(3);
    expect(label.compartments.has('secrets')).toBe(true);
    expect(label.compartments.has('credentials')).toBe(true);
  });

  it('content raises label above extension/path', () => {
    // Normal .ts file but with an API key in content
    const label = resolveFileLabel('/project/src/config.ts', {
      content: 'export const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";',
    });
    expect(label.level).toBe(3);
    expect(label.compartments.has('secrets')).toBe(true);
  });

  it('quickFileLabel skips content scan', () => {
    // .ts file with secrets in content — quickFileLabel won't see them
    const quick = quickFileLabel('/project/src/config.ts');
    expect(isBottom(quick)).toBe(true);

    // Full resolution sees the secret
    const full = resolveFileLabel('/project/src/config.ts', {
      content: 'export const key = "sk-ant-abcdefghijklmnopqrstuvwxyz";',
    });
    expect(full.level).toBe(3);
  });
});

describe('Conservative (highest wins) property', () => {
  it('label can only go up when combining layers', () => {
    const ext = resolveFileLabel('/project/.env'); // level 2
    const path = resolveFileLabel('/project/secrets/config.json'); // level 3
    // Combined should be at least max(2, 3) = 3
    const combined = resolveFileLabel('/project/secrets/.env');
    expect(combined.level).toBeGreaterThanOrEqual(Math.max(ext.level, path.level));
  });

  it('dominance preserved: combined dominates individual layers', () => {
    const combined = resolveFileLabel('/project/secrets/.env.production', {
      content: 'password = "hunter2isnotgood"',
    });
    const extOnly = resolveFileLabel('/project/.env.production');
    const pathOnly = resolveFileLabel('/project/secrets/dummy.txt');
    expect(dominates(combined, extOnly)).toBe(true);
    expect(dominates(combined, pathOnly)).toBe(true);
  });
});
