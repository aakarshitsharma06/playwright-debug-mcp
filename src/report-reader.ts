import * as fs from 'fs';
import * as path from 'path';

export interface FailedTest {
  title: string;
  file: string;
  status: string;
  error: string;
  duration_ms: number;
  trace_path: string;
}

export function getFailedTests(reportPath: string): FailedTest[] {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report not found at ${reportPath}. Add this to playwright.config.ts:\nreporter: [['json', { outputFile: 'test-results/results.json' }]]`);
  }

  let reportData;
  try {
    const fileContent = fs.readFileSync(reportPath, 'utf-8');
    reportData = JSON.parse(fileContent);
  } catch (err: any) {
    throw new Error(`Failed to read or parse report at ${reportPath}: ${err.message}`);
  }

  const failedTests: FailedTest[] = [];

  function processSuite(suite: any) {
    if (suite.specs) {
      for (const spec of suite.specs) {
        const title = spec.title ?? '';
        const file = spec.file ?? '';
        for (const test of spec.tests || []) {
          const status = test.status;
          if (status === 'failed' || status === 'timedOut') {
            for (const result of test.results || []) {
              if (result.status === 'failed' || result.status === 'timedOut') {
                const errorMessage = result.error?.message || 'Unknown error';
                const duration = result.duration || 0;
                
                let tracePath = '';
                const traceAttachment = (result.attachments || []).find((a: any) => a.name === 'trace');
                if (traceAttachment && traceAttachment.path) {
                  tracePath = traceAttachment.path;
                } else {
                  const sanitizedTitle = title.replace(/[^a-z0-9]/gi, "-").slice(0, 50);
                  tracePath = path.join(path.dirname(reportPath), "..", "test-results", sanitizedTitle, "trace.zip");
                }

                failedTests.push({
                  title,
                  file,
                  status,
                  error: errorMessage,
                  duration_ms: duration,
                  trace_path: tracePath
                });
              }
            }
          }
        }
      }
    }
    if (suite.suites) {
      for (const childSuite of suite.suites) {
        processSuite(childSuite);
      }
    }
  }

  if (reportData.suites) {
    for (const suite of reportData.suites) {
      processSuite(suite);
    }
  }

  return failedTests;
}
