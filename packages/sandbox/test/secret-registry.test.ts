import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as sandboxModule from '../src/index.js';

describe('Item 1: Secret Registry (collectSecretValues)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `test-secrets-${Date.now()}-`));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('exports collectSecretValues function', () => {
    const collectSecretValues = (sandboxModule as any).collectSecretValues;
    expect(typeof collectSecretValues).toBe('function');
  });

  it('collects secret values of length >= 8 from .env, .envrc, *.pem, *.key, id_rsa*, id_ed25519*, *.p12, *.pfx, credentials.json', async () => {
    const collectSecretValues = (sandboxModule as any).collectSecretValues;

    // .env file
    fs.writeFileSync(
      path.join(workspaceDir, '.env'),
      'SHORT=123\n' +
      'LONG_SECRET=super_secret_canary_12345\n' +
      'QUOTED_KEY="quoted_secret_val_999"\n' +
      'APP_TITLE=some_short_string\n' +
      'NON_SECRET_LONG_VAL=string_with_twenty_or_more_characters_here\n' +
      'APP_HOST=localhost\n' +
      'APP_ENV=production\n' +
      'DEBUG_MODE=true\n' +
      'ENABLE_FLAG=false\n' +
      'ENV_NAME=development\n' +
      'SUITE_TYPE=test\n'
    );

    // .envrc file
    fs.mkdirSync(path.join(workspaceDir, 'packages', 'x'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'packages', 'x', '.envrc'),
      'export API_TOKEN=my_special_token_987\n'
    );

    // .pem file
    fs.writeFileSync(
      path.join(workspaceDir, 'cert.pem'),
      '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----\n'
    );

    // credentials.json
    fs.mkdirSync(path.join(workspaceDir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'config', 'credentials.json'),
      '{\n  "client_secret": "json_secret_key_abcdef123"\n}\n'
    );

    // normal file that should NOT be scanned for secrets
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'normal text not a secret');

    const secrets: string[] = await collectSecretValues(workspaceDir);

    expect(secrets).toContain('super_secret_canary_12345');
    expect(secrets).toContain('quoted_secret_val_999');
    expect(secrets).not.toContain('123'); // < 8 characters
    expect(secrets).not.toContain('some_short_string'); // key does not match regex and length < 20
    expect(secrets).toContain('string_with_twenty_or_more_characters_here'); // length >= 20
    // Allowlist entries must be skipped
    expect(secrets).not.toContain('localhost');
    expect(secrets).not.toContain('production');
    expect(secrets).not.toContain('development');
    expect(secrets).not.toContain('test');
    expect(secrets).not.toContain('true');
    expect(secrets).not.toContain('false');

    // PEM checks: only base64 lines, not BEGIN/END headers
    expect(secrets.some((s: string) => s.includes('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'))).toBe(true);
    expect(secrets).not.toContain('-----BEGIN CERTIFICATE-----');
    expect(secrets).not.toContain('-----END CERTIFICATE-----');

    expect(secrets.some((s: string) => s.includes('json_secret_key_abcdef123'))).toBe(true);
  });

  it('collects secret values from .npmrc, .netrc, .git-credentials, .pypirc, .aws/credentials, .docker/config.json, *.tfvars ignoring ${ENV_VAR}', async () => {
    const collectSecretValues = (sandboxModule as any).collectSecretValues;

    // .npmrc
    fs.writeFileSync(
      path.join(workspaceDir, '.npmrc'),
      '//registry.npmjs.org/:_authToken=npm_secret_token_12345\nregistry=https://registry.npmjs.org/${NPM_TOKEN}\n'
    );

    // .netrc
    fs.writeFileSync(
      path.join(workspaceDir, '.netrc'),
      'machine api.github.com login myuser password netrc_secret_password_123\nmachine gitlab.com password ${GITLAB_TOKEN}\n'
    );

    // .git-credentials
    fs.writeFileSync(
      path.join(workspaceDir, '.git-credentials'),
      'https://myuser:git_cred_secret_pass_123@github.com\n'
    );

    // .pypirc
    fs.writeFileSync(
      path.join(workspaceDir, '.pypirc'),
      '[pypi]\nusername = ${PYPI_USER}\npassword = pypi_secret_token_98765\n'
    );

    // .aws/credentials
    fs.mkdirSync(path.join(workspaceDir, '.aws'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.aws', 'credentials'),
      '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = aws_secret_key_abcdef123\n'
    );

    // .docker/config.json
    fs.mkdirSync(path.join(workspaceDir, '.docker'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.docker', 'config.json'),
      JSON.stringify({
        auths: {
          'https://index.docker.io/v1/': {
            auth: 'docker_secret_auth_token_xyz',
          },
        },
      })
    );

    // terraform.tfvars
    fs.writeFileSync(
      path.join(workspaceDir, 'terraform.tfvars'),
      'db_password = "tfvars_secret_password_456"\n'
    );

    const secrets: string[] = await collectSecretValues(workspaceDir);

    expect(secrets).toContain('npm_secret_token_12345');
    expect(secrets).not.toContain('${NPM_TOKEN}');
    expect(secrets).toContain('netrc_secret_password_123');
    expect(secrets).not.toContain('${GITLAB_TOKEN}');
    expect(secrets.some((s: string) => s.includes('git_cred_secret_pass_123'))).toBe(true);
    expect(secrets).toContain('pypi_secret_token_98765');
    expect(secrets).not.toContain('${PYPI_USER}');
    expect(secrets).toContain('aws_secret_key_abcdef123');
    expect(secrets).toContain('docker_secret_auth_token_xyz');
    expect(secrets).toContain('tfvars_secret_password_456');
  });
});
