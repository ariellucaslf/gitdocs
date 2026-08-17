import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';

export interface GeminiAnalysisResult {
  summaryMarkdown: string;
  suggestedReadmeUpdate: string | null;
  hasStructuralChanges: boolean;
}

export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;
  private readonly modelName = 'gemini-1.5-flash';
  private readonly maxDiffLength = 35000; // Defesa contra estouro de contexto e economia de tokens

  constructor() {
    if (env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    } else {
      console.warn('⚠️ GEMINI_API_KEY is not defined. AI analysis will operate in fallback mode.');
    }
  }

  /**
   * Sanitiza o diff do PR removendo arquivos irrelevantes como lockfiles, binários e minificados
   */
  sanitizeDiff(rawDiff: string): string {
    if (!rawDiff) return '';

    const lines = rawDiff.split('\n');
    const sanitizedLines: string[] = [];
    let isIgnoredFile = false;

    // Extensões e padrões que não agregam valor à análise de código com IA
    const ignoredPatterns = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.min.js',
      '.min.css',
      '.map',
      '.png',
      '.jpg',
      '.jpeg',
      '.svg',
      '.ico',
      '.pdf',
    ];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        isIgnoredFile = ignoredPatterns.some((pattern) => line.includes(pattern));
      }

      if (!isIgnoredFile) {
        sanitizedLines.push(line);
      }
    }

    let result = sanitizedLines.join('\n');

    // Truncamento defensivo caso o diff ainda seja massivo
    if (result.length > this.maxDiffLength) {
      result = `${result.slice(0, this.maxDiffLength)}\n\n[... Diff truncated for token optimization ...]`;
    }

    return result;
  }

  /**
   * Envia o diff sanitizado ao Gemini e retorna o resumo estruturado e possíveis atualizações de README
   */
  async analyzePullRequest(
    prTitle: string,
    prBody: string | null,
    rawDiff: string
  ): Promise<GeminiAnalysisResult> {
    const cleanDiff = this.sanitizeDiff(rawDiff);

    if (!cleanDiff.trim()) {
      return {
        summaryMarkdown: '### 🤖 GitDocs AI Review\n\n*No reviewable code changes detected in this Pull Request.*',
        suggestedReadmeUpdate: null,
        hasStructuralChanges: false,
      };
    }

    if (!this.genAI) {
      return {
        summaryMarkdown: `### 🤖 GitDocs AI Review\n\n> ⚠️ **AI analysis skipped:** \`GEMINI_API_KEY\` is not configured on the server.`,
        suggestedReadmeUpdate: null,
        hasStructuralChanges: false,
      };
    }

    const prompt = `
You are GitDocs AI, an expert Senior Software Engineer and Open Source Documentation Maintainer.
Analyze the following GitHub Pull Request diff and provide a comprehensive, structured code review and documentation suggestion.

Pull Request Title: "${prTitle}"
Pull Request Description: "${prBody || 'No description provided.'}"

Diff content:
\`\`\`diff
${cleanDiff}
\`\`\`

Instructions:
1. Provide a clean, developer-friendly Markdown review report.
2. Group the code changes into clear categories:
   - 🚀 **New Features / Enhancements**
   - 🐛 **Bug Fixes**
   - ♻️ **Refactoring & Code Quality**
   - ⚠️ **Breaking Changes / Critical Notices** (if any)
3. Include a bulleted checklist of key modifications.
4. Assess if the changes introduce new features, environment variables, commands, or architectural changes that MUST be documented in the repository's \`README.md\`.
5. If README updates are needed:
   - Return a specific section labeled \`---README_UPDATE_START---\` followed ONLY by the updated or suggested markdown block, and end with \`---README_UPDATE_END---\`.
   - If NO README updates are needed, omit this block entirely.

Format your entire response cleanly in Markdown.
`;

    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });
      const response = await model.generateContent(prompt);
      const text = response.response.text();

      let summaryMarkdown = text;
      let suggestedReadmeUpdate: string | null = null;
      let hasStructuralChanges = false;

      // Extract README suggestion block if present
      const readmeStartTag = '---README_UPDATE_START---';
      const readmeEndTag = '---README_UPDATE_END---';

      if (text.includes(readmeStartTag) && text.includes(readmeEndTag)) {
        const parts = text.split(readmeStartTag);
        summaryMarkdown = parts[0]?.trim() || '';
        const readmeContent = parts[1]?.split(readmeEndTag)[0]?.trim();

        if (readmeContent) {
          suggestedReadmeUpdate = readmeContent;
          hasStructuralChanges = true;
        }
      }

      // Add GitDocs branding header if not present
      if (!summaryMarkdown.startsWith('## 🤖 GitDocs AI Review')) {
        summaryMarkdown = `## 🤖 GitDocs AI Review\n\n${summaryMarkdown}`;
      }

      return {
        summaryMarkdown,
        suggestedReadmeUpdate,
        hasStructuralChanges,
      };
    } catch (error) {
      console.error('❌ GeminiService analysis error:', error);
      return {
        summaryMarkdown: `## 🤖 GitDocs AI Review\n\n> ⚠️ *Failed to process AI analysis due to an internal error:* ${error instanceof Error ? error.message : 'Unknown error'}`,
        suggestedReadmeUpdate: null,
        hasStructuralChanges: false,
      };
    }
  }
}

export const geminiService = new GeminiService();
