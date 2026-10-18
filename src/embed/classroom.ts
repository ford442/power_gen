/**
 * Post-boot classroom wiring (#224 §5), started by lab-post-boot.ts once the
 * lab is up:
 *
 *   - every tab becomes a student on `BroadcastChannel('seg-lab')` — it
 *     answers teacher-console pings with its focus / mode and applies
 *     broadcast configs and experiments through the embed handlers;
 *   - `?embed=1` installs the postMessage endpoint (embed-host.ts);
 *   - `?teacher=1` opens the teacher console (teacher-console.ts).
 */
import { labConfig } from '../config/lab-config';
import { setLabStatus } from '../config/lab-status';
import { browserLabHost } from './browser-host';
import { createStudentEndpoint, newTabId, type StudentEndpoint } from './classroom-channel';
import { LAB_CHANNEL_NAME, type LabReply, type LabRequest } from './embed-protocol';

/** This tab's id on the classroom channel — shared with the teacher console. */
export const classroomTabId = newTabId();

let student: StudentEndpoint | null = null;

function describe(req: LabRequest, reply: LabReply): string | null {
  if (req.type === 'lab:ping' || req.type === 'lab:hello') return null;
  if (!reply.ok) return `Teacher ${req.type.slice(4)} failed: ${reply.error}`;
  if (req.type === 'lab:loadConfig') {
    const r = reply.result as { applied?: unknown[]; reloading?: boolean } | null;
    return `Teacher loaded a lab: ${r?.applied?.length ?? 0} setting(s)${r?.reloading ? ' — reloading' : ''}`;
  }
  return 'Teacher ran an experiment on this tab';
}

function startStudent(): void {
  if (student || typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(LAB_CHANNEL_NAME);
  student = createStudentEndpoint({
    channel,
    tabId: classroomTabId,
    host: browserLabHost(),
    onHandled(req, reply) {
      const text = describe(req, reply);
      if (text) setLabStatus(text, 'classroom');
    }
  });
  student.announce();
  window.addEventListener('pagehide', () => student?.bye());
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) student?.announce();
  });
}

export async function startClassroom(): Promise<void> {
  startStudent();
  const cfg = labConfig();
  if (cfg.embed) (await import('./embed-host')).installEmbedHost();
  if (cfg.teacher) (await import('./teacher-console')).openTeacherConsole();
}
