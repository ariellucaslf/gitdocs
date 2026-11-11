import crypto from 'node:crypto';

export interface PatchOperation {
  oldText: string;
  newText: string;
}

export type PatchErrorCode =
  | 'INVALID_TARGET_PATH'
  | 'EMPTY_OPERATIONS'
  | 'TOO_MANY_OPERATIONS'
  | 'PAYLOAD_TOO_LARGE'
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_REPLACEMENT'
  | 'OVERLAPPING_OPERATIONS'
  | 'TOTAL_REMOVAL_REJECTED'
  | 'EMPTY_CREATION';

export interface PatchSuccessResult {
  success: true;
  baseFileHash: string;
  newContentHash: string;
  patchedContent: string;
  operationsCount: number;
}

export interface PatchFailureResult {
  success: false;
  code: PatchErrorCode;
  error: string;
}

export type PatchResult = PatchSuccessResult | PatchFailureResult;

const MAX_OPERATIONS = 10;
const MAX_NEW_TEXT_BYTES = 20 * 1024; // 20 KiB

export class DocPatchService {
  /**
   * Validates target path against ADR 0003 rules.
   * Path must target README.md at repository root without path traversal or symlinks.
   */
  isValidTargetPath(targetPath: string): boolean {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const normalized = targetPath.trim().replace(/\\/g, '/');
    if (normalized.includes('..') || normalized.startsWith('/') || normalized.includes('./')) {
      return false;
    }
    return /^readme(\.md)?$/i.test(normalized);
  }

  /**
   * Applies patch operations to original content with strict byte-preservation
   * and unambiguous replacement guarantees.
   */
  applyPatch(
    originalContent: string | null,
    operations: PatchOperation[],
    targetPath: string = 'README.md'
  ): PatchResult {
    // 1. Path validation
    if (!this.isValidTargetPath(targetPath)) {
      return {
        success: false,
        code: 'INVALID_TARGET_PATH',
        error: `Only 'README.md' at repository root is supported for automated documentation proposals. Target: '${targetPath}'`,
      };
    }

    // 2. Operations count validation
    if (!Array.isArray(operations) || operations.length === 0) {
      return {
        success: false,
        code: 'EMPTY_OPERATIONS',
        error: 'Operations list must not be empty.',
      };
    }

    if (operations.length > MAX_OPERATIONS) {
      return {
        success: false,
        code: 'TOO_MANY_OPERATIONS',
        error: `Exceeded maximum permitted operations (${MAX_OPERATIONS}). Received ${operations.length}.`,
      };
    }

    // 3. New text size limit validation
    const totalNewBytes = operations.reduce(
      (sum, op) => sum + Buffer.byteLength(op.newText || '', 'utf8'),
      0
    );

    if (totalNewBytes > MAX_NEW_TEXT_BYTES) {
      return {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: `Total new text size (${totalNewBytes} bytes) exceeds maximum limit of 20 KiB (${MAX_NEW_TEXT_BYTES} bytes).`,
      };
    }

    // 4. File creation scenario (when original file does not exist)
    if (originalContent === null) {
      const firstOp = operations[0];
      if (operations.length !== 1 || !firstOp || firstOp.oldText !== '') {
        return {
          success: false,
          code: 'EMPTY_CREATION',
          error: 'When creating a new README.md, exactly one operation with empty oldText is required.',
        };
      }

      const createdContent = firstOp.newText;
      if (!createdContent || createdContent.trim().length === 0) {
        return {
          success: false,
          code: 'EMPTY_CREATION',
          error: 'Created README.md content must not be empty.',
        };
      }

      const baseFileHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
      const newContentHash = crypto.createHash('sha256').update(createdContent, 'utf8').digest('hex');

      return {
        success: true,
        baseFileHash,
        newContentHash,
        patchedContent: createdContent,
        operationsCount: 1,
      };
    }

    // 5. Existing file patching: find exact offsets and ensure uniqueness (Case V17)
    const baseFileHash = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');

    interface LocatedOperation {
      startOffset: number;
      endOffset: number;
      oldText: string;
      newText: string;
      opIndex: number;
    }

    const locatedOps: LocatedOperation[] = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op || !op.oldText) {
        return {
          success: false,
          code: 'TARGET_NOT_FOUND',
          error: `Operation #${i + 1} has empty target 'oldText' in an existing file.`,
        };
      }

      // Check occurrences in original content
      let count = 0;
      let firstIndex = -1;
      let searchIndex = 0;

      while ((searchIndex = originalContent.indexOf(op.oldText, searchIndex)) !== -1) {
        count++;
        if (firstIndex === -1) {
          firstIndex = searchIndex;
        }
        searchIndex += op.oldText.length;
      }

      if (count === 0) {
        return {
          success: false,
          code: 'TARGET_NOT_FOUND',
          error: `Target text for operation #${i + 1} not found in the original file.`,
        };
      }

      if (count > 1) {
        return {
          success: false,
          code: 'AMBIGUOUS_REPLACEMENT',
          error: `Target text for operation #${i + 1} is ambiguous: found ${count} occurrences in original file. Disambiguate context.`,
        };
      }

      locatedOps.push({
        startOffset: firstIndex,
        endOffset: firstIndex + op.oldText.length,
        oldText: op.oldText,
        newText: op.newText,
        opIndex: i,
      });
    }

    // 6. Check for overlaps and sort by offset
    locatedOps.sort((a, b) => a.startOffset - b.startOffset);

    for (let i = 1; i < locatedOps.length; i++) {
      const prev = locatedOps[i - 1];
      const curr = locatedOps[i];

      if (!prev || !curr) continue;

      if (curr.startOffset < prev.endOffset) {
        return {
          success: false,
          code: 'OVERLAPPING_OPERATIONS',
          error: `Operations #${prev.opIndex + 1} and #${curr.opIndex + 1} overlap at character offsets [${curr.startOffset}, ${prev.endOffset}].`,
        };
      }
    }

    // 7. Reconstruct content preserving all bytes outside operations
    let patchedContent = '';
    let lastOffset = 0;

    for (const op of locatedOps) {
      // Append unchanged bytes prior to operation
      patchedContent += originalContent.slice(lastOffset, op.startOffset);
      // Append replacement
      patchedContent += op.newText;
      lastOffset = op.endOffset;
    }

    // Append remaining unchanged bytes
    patchedContent += originalContent.slice(lastOffset);

    // 8. Prevent total removal of file content
    if (patchedContent.trim().length === 0) {
      return {
        success: false,
        code: 'TOTAL_REMOVAL_REJECTED',
        error: 'Operations resulted in complete removal of README.md content. Total file wipe is rejected.',
      };
    }

    const newContentHash = crypto.createHash('sha256').update(patchedContent, 'utf8').digest('hex');

    return {
      success: true,
      baseFileHash,
      newContentHash,
      patchedContent,
      operationsCount: operations.length,
    };
  }
}

export const docPatchService = new DocPatchService();
