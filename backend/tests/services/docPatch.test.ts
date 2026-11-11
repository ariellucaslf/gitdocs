import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { docPatchService } from '../../src/services/docPatch.service.js';

describe('Contextual Documentation Patching Engine (ADR 0003, V17)', () => {
  const originalReadme = `# GitDocs

Automated PR review and documentation bot.

## Installation

Run the following command to install:
\`\`\`bash
npm install gitdocs
\`\`\`

## Features

- Fast analysis
- Secure webhooks

## License

MIT
`;

  describe('Case V17: Byte Preservation & Unambiguous Replacements', () => {
    it('strictly preserves all bytes outside replaced sections when applying targeted operations', () => {
      const operations = [
        {
          oldText: 'npm install gitdocs',
          newText: 'npm install --save-dev gitdocs',
        },
        {
          oldText: '- Secure webhooks',
          newText: '- Secure webhooks with HMAC-SHA256\n- Persistent queueing',
        },
      ];

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Verify that portions before, between, and after operations are identical byte-for-byte
      expect(result.patchedContent).toContain('# GitDocs\n\nAutomated PR review and documentation bot.\n\n## Installation\n\nRun the following command to install:\n```bash\nnpm install --save-dev gitdocs\n```\n\n## Features\n\n- Fast analysis\n- Secure webhooks with HMAC-SHA256\n- Persistent queueing\n\n## License\n\nMIT\n');
      expect(result.baseFileHash).toBe(
        crypto.createHash('sha256').update(originalReadme, 'utf8').digest('hex')
      );
      expect(result.newContentHash).toBe(
        crypto.createHash('sha256').update(result.patchedContent, 'utf8').digest('hex')
      );
    });

    it('rejects patch when target text occurs multiple times (ambiguous headings or repeated blocks)', () => {
      const readmeWithDuplicateHeading = `# Project

## Section

First section content.

## Section

Second section content.
`;

      const operations = [
        {
          oldText: '## Section',
          newText: '## Updated Section',
        },
      ];

      const result = docPatchService.applyPatch(readmeWithDuplicateHeading, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('AMBIGUOUS_REPLACEMENT');
      expect(result.error).toContain('found 2 occurrences');
    });

    it('rejects patch when operations overlap in the file content', () => {
      const operations = [
        {
          oldText: '## Installation\n\nRun the following command',
          newText: '## Quickstart\n\nRun this',
        },
        {
          oldText: 'Run the following command to install:\n```bash',
          newText: 'Execute:\n```bash',
        },
      ];

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('OVERLAPPING_OPERATIONS');
      expect(result.error).toContain('overlap at character offsets');
    });

    it('rejects patch when oldText is not found in the original file', () => {
      const operations = [
        {
          oldText: 'Nonexistent text block that does not exist in README',
          newText: 'Replacement text',
        },
      ];

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('TARGET_NOT_FOUND');
    });

    it('rejects patch when targetPath is not README.md (e.g. symlinks, path traversal, or code files)', () => {
      const operations = [
        {
          oldText: 'npm install gitdocs',
          newText: 'npm install gitdocs-next',
        },
      ];

      const traversalResult = docPatchService.applyPatch(originalReadme, operations, '../secret.env');
      expect(traversalResult.success).toBe(false);
      if (!traversalResult.success) {
        expect(traversalResult.code).toBe('INVALID_TARGET_PATH');
      }

      const codeFileResult = docPatchService.applyPatch(originalReadme, operations, 'src/index.ts');
      expect(codeFileResult.success).toBe(false);
      if (!codeFileResult.success) {
        expect(codeFileResult.code).toBe('INVALID_TARGET_PATH');
      }
    });

    it('rejects patch when number of operations exceeds limit (10 operations)', () => {
      const operations = Array.from({ length: 11 }, (_, i) => ({
        oldText: `line ${i}`,
        newText: `new line ${i}`,
      }));

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('TOO_MANY_OPERATIONS');
    });

    it('rejects patch when total new text exceeds 20 KiB', () => {
      const hugeNewText = 'x'.repeat(21 * 1024);
      const operations = [
        {
          oldText: 'MIT',
          newText: hugeNewText,
        },
      ];

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects patch that results in total file content wipe', () => {
      const operations = [
        {
          oldText: originalReadme,
          newText: '   \n  \n',
        },
      ];

      const result = docPatchService.applyPatch(originalReadme, operations, 'README.md');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.code).toBe('TOTAL_REMOVAL_REJECTED');
    });

    it('handles clean creation when original file does not exist (null)', () => {
      const operations = [
        {
          oldText: '',
          newText: '# New Documentation\n\nInitial README created by proposal.\n',
        },
      ];

      const result = docPatchService.applyPatch(null, operations, 'README.md');

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.patchedContent).toBe('# New Documentation\n\nInitial README created by proposal.\n');
      expect(result.baseFileHash).toBe(crypto.createHash('sha256').update('', 'utf8').digest('hex'));
    });
  });
});
