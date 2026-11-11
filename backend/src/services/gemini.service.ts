import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import {
  AnalysisResult,
  AiErrorCode,
  validatedAnalysisSchema,
} from '../types/analysis.js';

export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;
  private readonly maxDiffLength = 35000;
  private readonly maxTitleLength = 500;
  private readonly maxBodyLength = 8000;

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    }
  }

  /**
   * Sanitizes diff by stripping sensitive files (secrets, keys, env) and non-code assets (locks, binaries).
   */
  sanitizeDiff(rawDiff: string): { cleanDiff: string; truncated: boolean } {
    if (!rawDiff) return { cleanDiff: '', truncated: false };

    const lines = rawDiff.split('\n');
    const sanitizedLines: string[] = [];
    let isIgnoredFile = false;

    const ignoredPatterns = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.env',
      '.env.',
      '.pem',
      '.key',
      '.cert',
      '.pfx',
      'id_rsa',
      'credentials.json',
      '.min.js',
      '.min.css',
      '.map',
      '.png',
      '.jpg',
      '.jpeg',
      '.svg',
      '.ico',
      '.pdf',
      '.wasm',
    ];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const lineLower = line.toLowerCase();
        isIgnoredFile = ignoredPatterns.some((pattern) => lineLower.includes(pattern));
      }

      if (!isIgnoredFile) {
        sanitizedLines.push(line);
      }
    }

    let cleanDiff = sanitizedLines.join('\n').trim();
    let truncated = false;

    if (cleanDiff.length > this.maxDiffLength) {
      cleanDiff = cleanDiff.slice(0, this.maxDiffLength);
      truncated = true;
    }

    return { cleanDiff, truncated };
  }

  /**
   * Classifies error types into standard domain codes with explicit retryability.
   */
  classifyError(error: unknown): { code: AiErrorCode; retryable: boolean; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    const msgLower = message.toLowerCase();

    if (
      msgLower.includes('api key') ||
      msgLower.includes('401') ||
      msgLower.includes('unauthorized') ||
      msgLower.includes('forbidden')
    ) {
      return { code: 'AUTHENTICATION', retryable: false, message };
    }

    if (
      msgLower.includes('rate limit') ||
      msgLower.includes('429') ||
      msgLower.includes('resource_exhausted') ||
      msgLower.includes('quota')
    ) {
      return { code: 'RATE_LIMIT', retryable: true, message };
    }

    if (
      msgLower.includes('timeout') ||
      msgLower.includes('deadline') ||
      msgLower.includes('aborted')
    ) {
      return { code: 'TIMEOUT', retryable: true, message };
    }

    if (
      msgLower.includes('503') ||
      msgLower.includes('unavailable') ||
      msgLower.includes('overloaded')
    ) {
      return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message };
    }

    return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message };
  }

  /**
   * Analyzes PR diff and returns a discriminated AnalysisResult union.
   */
  async analyzePullRequest(
    prTitle: string,
    prBody: string | null,
    rawDiff: string
  ): Promise<AnalysisResult> {
    const { cleanDiff, truncated } = this.sanitizeDiff(rawDiff);

    if (!cleanDiff.trim()) {
      return {
        kind: 'skipped',
        reason: 'EMPTY_DIFF',
      };
    }

    if (!env.GEMINI_API_KEY) {
      return {
        kind: 'failed',
        code: 'CONFIGURATION',
        message: 'GEMINI_API_KEY is not configured on the server',
        retryable: false,
      };
    }

    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    }

    const title = (prTitle || 'Untitled PR').slice(0, this.maxTitleLength);
    const description = (prBody || 'No description provided.').slice(0, this.maxBodyLength);

    const prompt = `
You are GitDocs AI, an expert Senior Software Engineer and Open Source Documentation Maintainer.
Analyze the following Pull Request diff and provide a structured JSON analysis strictly adhering to the schema below.

JSON Schema:
{
  "summary": "High-level summary of the PR changes and design decisions (markdown allowed)",
  "categories": ["feat" | "fix" | "refactor" | "docs" | "test" | "chore" | "security" | "performance" | "breaking_change"],
  "findings": [
    {
      "file": "path/to/file.ts",
      "lineRange": "10-25",
      "category": "feat" | "fix" | "refactor" | "docs" | "test" | "chore" | "security" | "performance" | "breaking_change",
      "severity": "info" | "warning" | "critical",
      "title": "Short title describing finding",
      "message": "Detailed technical analysis of the finding",
      "evidence": "Concrete snippet or evidence found in diff"
    }
  ],
  "suggestedDocUpdate": {
    "title": "Title of suggested documentation update",
    "targetFile": "README.md",
    "description": "Explanation of why README needs updating",
    "proposedContent": "Markdown snippet to add or update",
    "evidence": "Evidence from diff that justifies the doc change"
  } | null
}

Pull Request Title: "${title}"
Pull Request Description: "${description}"

Diff content:
\`\`\`diff
${cleanDiff}
\`\`\`

Return ONLY raw JSON, with no markdown code fence and no extra commentary.
`;

    try {
      const model = this.genAI.getGenerativeModel({
        model: env.GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      const response = await model.generateContent(prompt);
      const text = response.response.text();

      let parsed: unknown;
      try {
        const cleanedText = text
          .trim()
          .replace(/^```json\s*/, '')
          .replace(/```\s*$/, '')
          .trim();
        parsed = JSON.parse(cleanedText);
      } catch (jsonErr) {
        return {
          kind: 'failed',
          code: 'INVALID_OUTPUT',
          message: `Model response was not valid JSON: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          retryable: false,
        };
      }

      const validation = validatedAnalysisSchema.safeParse(parsed);
      if (!validation.success) {
        return {
          kind: 'failed',
          code: 'INVALID_OUTPUT',
          message: `Model JSON output did not match expected schema: ${validation.error.message}`,
          retryable: false,
        };
      }

      const usageMetadata = response.response.usageMetadata;
      const usage = {
        model: env.GEMINI_MODEL,
        inputTokens: usageMetadata?.promptTokenCount,
        outputTokens: usageMetadata?.candidatesTokenCount,
      };

      return {
        kind: 'analyzed',
        data: validation.data,
        usage,
        truncated,
      };
    } catch (err: unknown) {
      const classified = this.classifyError(err);
      return {
        kind: 'failed',
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
      };
    }
  }
}

export const geminiService = new GeminiService();
