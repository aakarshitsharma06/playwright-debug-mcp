import * as fs from 'fs';
import AdmZip from 'adm-zip';

export function getScreenshotBase64(tracePath: string, sha1: string): string | null {
  if (!fs.existsSync(tracePath)) {
    return null;
  }
  
  let zip: AdmZip;
  try {
    zip = new AdmZip(tracePath);
  } catch (err: any) {
    return null;
  }
  
  const entry = zip.getEntry(sha1);
  
  if (!entry) {
    return null;
  }
  
  return entry.getData().toString('base64');
}

export interface ScreenshotContext {
  before_action: string | null;
  after_action: string | null;
}

export function getScreenshotsAroundTime(tracePath: string, targetTime: number): ScreenshotContext {
  if (!fs.existsSync(tracePath)) return { before_action: null, after_action: null };

  let zip: AdmZip;
  try {
    zip = new AdmZip(tracePath);
  } catch (err: any) {
    return { before_action: null, after_action: null };
  }

  const traceEntry = zip.getEntries().find(e =>
    e.entryName.endsWith('-trace.trace') || e.entryName === 'trace.trace'
  );
  if (!traceEntry) return { before_action: null, after_action: null };

  const traceContent = traceEntry.getData().toString('utf8');
  const traceLines = traceContent.split('\n').filter(l => l.trim() !== '');
  
  const frames: any[] = [];
  for (const line of traceLines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'screencast-frame') {
        frames.push(event);
      }
    } catch (e) { }
  }

  let frameBefore: any = null;
  let frameAfter: any = null;

  for (const frame of frames) {
    if (frame.timestamp <= targetTime) {
      if (!frameBefore || frame.timestamp > frameBefore.timestamp) {
        frameBefore = frame;
      }
    }
    if (frame.timestamp >= targetTime) {
      if (!frameAfter || frame.timestamp < frameAfter.timestamp) {
        frameAfter = frame;
      }
    }
  }

  const result: ScreenshotContext = { before_action: null, after_action: null };
  
  const extractImage = (sha1Value: string) => {
    const possiblePaths = [
      `resources/${sha1Value}.jpeg`,
      `resources/${sha1Value}`,
      sha1Value
    ];
    for (const p of possiblePaths) {
      const entry = zip.getEntry(p);
      if (entry) return entry.getData().toString('base64');
    }
    return null;
  };

  if (frameBefore && frameBefore.sha1) {
    result.before_action = extractImage(frameBefore.sha1);
  }

  if (frameAfter && frameAfter.sha1) {
    result.after_action = extractImage(frameAfter.sha1);
  }

  return result;
}
