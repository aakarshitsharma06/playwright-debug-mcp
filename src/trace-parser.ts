import * as fs from 'fs';
import AdmZip from 'adm-zip';

export interface ActionSummary {
  action: string;
  selector: string;
  duration_ms: number;
  status: string;
}

export interface TraceAnalysisResult {
  failing_action: string;
  error_message: string;
  selector_used: string;
  console_errors: string[];
  network_failures: { url: string; method: string; status: number }[];
  action_history: ActionSummary[];
  recent_network_requests: { url: string; method: string; status: number }[];
  dom_snapshot: string;
  screenshot_sha1: string | null;
}

export function parseTrace(tracePath: string): TraceAnalysisResult {
  if (!fs.existsSync(tracePath)) {
    throw new Error(`Trace file not found at ${tracePath}. Run tests with trace enabled first — add trace: 'on' to playwright.config.ts use section.`);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(tracePath);
  } catch (err: any) {
    throw new Error(`Could not parse trace.zip at ${tracePath}: ${err.message}. File may be corrupt or from an incompatible Playwright version.`);
  }

  const entries = zip.getEntries().map(e => e.entryName);
  process.stderr.write(`[trace-parser] zip has ${entries.length} entries, trace: ${entries.find(e => e.endsWith('.trace'))}\n`);

  const traceEntry = zip.getEntries().find(e =>
    e.entryName.endsWith('-trace.trace') || e.entryName === 'trace.trace'
  );
  if (!traceEntry) {
    throw new Error(`Could not find trace file in zip. Found entries: ${JSON.stringify(entries)}`);
  }
  process.stderr.write(`[trace-parser] Using trace file: ${traceEntry.entryName}\n`);

  const networkEntry = zip.getEntries().find(e =>
    e.entryName.endsWith('-trace.network') || e.entryName === 'trace.network'
  );
  process.stderr.write(`[trace-parser] Using network file: ${networkEntry?.entryName}\n`);
  
  const traceContent = traceEntry.getData().toString('utf8');
  const traceLines = traceContent.split('\n').filter(l => l.trim() !== '');
  
  const beforeEvents = new Map<string, any>();
  const afterEvents = new Map<string, any>();
  const consoleErrors: string[] = [];
  
  for (const line of traceLines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'before' && event.callId) {
        beforeEvents.set(event.callId, event);
      } else if (event.type === 'after' && event.callId) {
        afterEvents.set(event.callId, event);
      } else if (event.type === 'screencast-frame') {
        // collected only by get_screenshots_around_time — skip here for memory efficiency
      } else if (event.type === 'event' && event.method === 'console') {
        if (event.params && event.params.type === 'error') {
          consoleErrors.push(event.params.text || '');
        }
      } else if (event.type === 'event' && event.method === 'pageError') {
        if (event.params && event.params.error) {
          consoleErrors.push(event.params.error.message || '');
        }
      }
    } catch (e) {
      // ignore
    }
  }

  let failingActionCallId: string | null = null;
  let lastFailedAfterEvent: any = null;

  // Track the failing action with the HIGHEST endTime (chronologically last failure, not Map insertion order)
  for (const [callId, afterEvent] of afterEvents.entries()) {
    if (afterEvent.error) {
      const currentEndTime = afterEvent.endTime ?? -Infinity;
      const existingEndTime = lastFailedAfterEvent?.endTime ?? -Infinity;
      if (currentEndTime >= existingEndTime) {
        failingActionCallId = callId;
        lastFailedAfterEvent = afterEvent;
      }
    }
  }

  if (!failingActionCallId) {
    for (const [callId, beforeEvent] of beforeEvents.entries()) {
      if (!afterEvents.has(callId)) {
        failingActionCallId = callId;
      }
    }
  }

  let failingAction = 'unknown';
  let errorMessage = 'unknown';
  let selectorUsed = '';
  
  if (failingActionCallId) {
    const beforeEvent = beforeEvents.get(failingActionCallId);
    
    if (lastFailedAfterEvent) {
      errorMessage = lastFailedAfterEvent.error?.message || lastFailedAfterEvent.error?.name || 'unknown';
    } else {
      errorMessage = "Action hung or test timed out before completion.";
    }

    if (beforeEvent) {
      failingAction = beforeEvent.apiName || 
                      (beforeEvent.class && beforeEvent.method ? `${beforeEvent.class}.${beforeEvent.method}` : 'unknown');
      if (beforeEvent.params && beforeEvent.params.selector) {
        selectorUsed = beforeEvent.params.selector;
      }
    }
  }

  const jpegEntries = zip.getEntries()
    .filter(e => e.entryName.startsWith('resources/') && e.entryName.endsWith('.jpeg'))
    .sort((a, b) => {
      const tsA = parseInt(a.entryName.replace('.jpeg', '').split('-').pop() ?? '0');
      const tsB = parseInt(b.entryName.replace('.jpeg', '').split('-').pop() ?? '0');
      return tsA - tsB;
    });
  process.stderr.write(`[trace-parser] Found ${jpegEntries.length} screenshots\n`);
  const screenshotSha1 = jpegEntries.length > 0
    ? jpegEntries[jpegEntries.length - 1].entryName
    : null;

  const allNetworkRequests: { url: string; method: string; status: number }[] = [];
  const networkFailures: { url: string; method: string; status: number }[] = [];
  if (networkEntry) {
    const networkContent = networkEntry.getData().toString('utf8');
    const networkLines = networkContent.split('\n').filter(l => l.trim() !== '');
    for (const line of networkLines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'resource' && event.response && event.request) {
          const status = event.response.status;
          const req = {
            url: event.request.url || '',
            method: event.request.method || '',
            status: status
          };
          allNetworkRequests.push(req);
          if (status >= 400 || status === 0) {
            networkFailures.push(req);
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }
  const recentNetworkRequests = allNetworkRequests.slice(-3);

  let domSnapshot = '';
  const htmlEntries = entries.filter(e => e.startsWith('resources/') && e.endsWith('.html'));
  if (htmlEntries.length > 0) {
    // Sort by compressed size descending — the most content-rich snapshot (typically the last page state)
    // is the largest. sha1 names are content-addressed and have no temporal ordering.
    const htmlZipEntries = zip.getEntries()
      .filter(e => e.entryName.startsWith('resources/') && e.entryName.endsWith('.html'))
      .sort((a, b) => b.header.size - a.header.size);
    const bestHtmlEntry = htmlZipEntries[0];
    if (bestHtmlEntry) {
      const htmlContent = bestHtmlEntry.getData().toString('utf8');
      const limit = 5000;
      if (htmlContent.length > limit) {
        domSnapshot = `<!-- DOM snapshot truncated to ${limit} chars (full size: ${htmlContent.length}) -->\n` + htmlContent.substring(0, limit);
      } else {
        domSnapshot = htmlContent;
      }
    }
  }

  process.stderr.write(`[trace-parser] Found ${traceLines.length} trace events\n`);
  if (failingActionCallId) {
    process.stderr.write(`[trace-parser] Failing action found: ${failingAction} - ${errorMessage}\n`);
  }

  const allActions: (ActionSummary & { _startTime: number })[] = [];
  for (const [callId, beforeEvent] of beforeEvents.entries()) {
    const afterEvent = afterEvents.get(callId);
    let status = 'hung';
    let duration = 0;
    if (afterEvent) {
      status = afterEvent.error ? 'failed' : 'ok';
      duration = (afterEvent.endTime != null && beforeEvent.startTime != null)
        ? afterEvent.endTime - beforeEvent.startTime
        : 0;
    }
    const actionName = beforeEvent.apiName || (beforeEvent.class && beforeEvent.method ? `${beforeEvent.class}.${beforeEvent.method}` : 'unknown');
    const selector = beforeEvent.params?.selector || '';
    allActions.push({
      action: actionName,
      selector,
      duration_ms: Math.round(duration),
      status,
      _startTime: beforeEvent.startTime || 0
    });
  }
  // Sort chronologically regardless of insertion order in the trace file
  allActions.sort((a, b) => a._startTime - b._startTime);
  const actionHistory: ActionSummary[] = allActions.slice(-5).map(({ _startTime, ...rest }) => rest);

  return {
    failing_action: failingAction,
    error_message: errorMessage,
    selector_used: selectorUsed,
    console_errors: consoleErrors,
    network_failures: networkFailures,
    action_history: actionHistory,
    recent_network_requests: recentNetworkRequests,
    dom_snapshot: domSnapshot,
    screenshot_sha1: screenshotSha1
  };
}

export function getNetworkLog(tracePath: string, filter: 'all' | 'failed' | '4xx' | '5xx'): any[] {
  if (!fs.existsSync(tracePath)) {
    throw new Error(`Trace file not found at ${tracePath}.`);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(tracePath);
  } catch (err: any) {
    throw new Error(`Could not parse trace.zip at ${tracePath}: ${err.message}`);
  }

  const entries = zip.getEntries().map(e => e.entryName);
  process.stderr.write(`[trace-parser] getNetworkLog: zip has ${entries.length} entries\n`);

  const networkEntry = zip.getEntries().find(e =>
    e.entryName.endsWith('-trace.network') || e.entryName === 'trace.network'
  );
  if (!networkEntry) {
    return [];
  }

  const networkContent = networkEntry.getData().toString('utf8');
  const networkLines = networkContent.split('\n').filter(l => l.trim() !== '');
  
  const results: any[] = [];
  for (const line of networkLines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'resource' && event.response && event.request) {
        const status = event.response.status;
        const url = event.request.url;
        const method = event.request.method;
        const duration = 0; // Not perfectly provided in this shape without correlating
        
        let include = false;
        if (filter === 'all') {
          include = true;
        } else if (filter === 'failed') {
          include = status >= 400 || status === 0;
        } else if (filter === '4xx') {
          include = status >= 400 && status < 500;
        } else if (filter === '5xx') {
          include = status >= 500;
        }

        if (include) {
          results.push({
            url,
            method,
            status,
            duration_ms: duration
          });
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return results;
}

export interface ActionDetail {
  action: string;
  selector: string;
  start_time: number;
  end_time: number | null;
  duration_ms: number;
  status: string;
  error_message: string | null;
}

export function getActionHistory(tracePath: string): ActionDetail[] {
  if (!fs.existsSync(tracePath)) {
    throw new Error(`Trace file not found at ${tracePath}.`);
  }
  
  let zip: AdmZip;
  try {
    zip = new AdmZip(tracePath);
  } catch (err: any) {
    throw new Error(`Could not parse trace.zip at ${tracePath}: ${err.message}`);
  }

  const traceEntry = zip.getEntries().find(e =>
    e.entryName.endsWith('-trace.trace') || e.entryName === 'trace.trace'
  );
  if (!traceEntry) return [];

  const traceContent = traceEntry.getData().toString('utf8');
  const traceLines = traceContent.split('\n').filter(l => l.trim() !== '');
  
  const beforeEvents = new Map<string, any>();
  const afterEvents = new Map<string, any>();
  
  for (const line of traceLines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'before' && event.callId) {
        beforeEvents.set(event.callId, event);
      } else if (event.type === 'after' && event.callId) {
        afterEvents.set(event.callId, event);
      }
    } catch (e) { }
  }

  const history: ActionDetail[] = [];
  for (const [callId, beforeEvent] of beforeEvents.entries()) {
    const afterEvent = afterEvents.get(callId);
    let status = 'hung';
    let duration = 0;
    let endTime = null;
    let errorMessage = null;

    if (afterEvent) {
      status = afterEvent.error ? 'failed' : 'ok';
      endTime = afterEvent.endTime != null ? afterEvent.endTime : null;
      if (endTime != null && beforeEvent.startTime != null) {
        duration = endTime - beforeEvent.startTime;
      }
      if (afterEvent.error) {
        errorMessage = afterEvent.error.message || afterEvent.error.name || 'unknown error';
      }
    }

    const actionName = beforeEvent.apiName || (beforeEvent.class && beforeEvent.method ? `${beforeEvent.class}.${beforeEvent.method}` : 'unknown');
    
    history.push({
      action: actionName,
      selector: beforeEvent.params?.selector || '',
      start_time: beforeEvent.startTime || 0,
      end_time: endTime,
      duration_ms: Math.round(duration),
      status,
      error_message: errorMessage
    });
  }
  
  history.sort((a, b) => a.start_time - b.start_time);
  return history;
}
