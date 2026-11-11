import { z } from 'zod';

export type AiErrorCode =
  | 'CONFIGURATION'
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_OUTPUT'
  | 'INPUT_TOO_LARGE';

export const findingCategorySchema = z.enum([
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'security',
  'performance',
  'breaking_change',
]);

export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const analysisFindingSchema = z.object({
  file: z.string(),
  lineRange: z.string().optional(),
  category: findingCategorySchema,
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string().max(200),
  message: z.string().max(2000),
  evidence: z.string().max(1000),
});

export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;

export const suggestedDocUpdateSchema = z.object({
  title: z.string().max(200),
  targetFile: z.string().default('README.md'),
  description: z.string().max(1000),
  proposedContent: z.string().max(20000),
  evidence: z.string().max(1000),
});

export type SuggestedDocUpdate = z.infer<typeof suggestedDocUpdateSchema>;

export const validatedAnalysisSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  summary: z.string().max(3000),
  categories: z.array(findingCategorySchema).min(1),
  findings: z.array(analysisFindingSchema).default([]),
  suggestedDocUpdate: suggestedDocUpdateSchema.nullable().optional(),
});

export type ValidatedAnalysis = z.infer<typeof validatedAnalysisSchema>;

export interface AnalysisUsage {
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

export type AnalysisResult =
  | {
      kind: 'analyzed';
      data: ValidatedAnalysis;
      usage: AnalysisUsage | null;
      truncated: boolean;
    }
  | {
      kind: 'skipped';
      reason: 'EMPTY_DIFF' | 'AI_DISABLED';
    }
  | {
      kind: 'failed';
      code: AiErrorCode;
      message: string;
      retryable: boolean;
    };
