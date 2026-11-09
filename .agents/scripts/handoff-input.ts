import { array, nonempty, record } from "../hooks/parse.ts";

function strict(input: unknown, keys: string[]) {
  const value = record(input);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown handoff field");
  return value;
}

export function renderHandoff(input: unknown) {
  const value = strict(input, ["header", "standingOrders", "programStore", "state", "jobs"]);
  const header = strict(value.header, [
    "status",
    "retiringThreadId",
    "blockers",
    "nextAction",
    "detailPaths",
    "jobReportPaths",
  ]);
  const packet = {
    header: {
      status: nonempty(header.status),
      retiringThreadId: nonempty(header.retiringThreadId),
      blockers: array(header.blockers).map(nonempty),
      nextAction: nonempty(header.nextAction),
      detailPaths: array(header.detailPaths).map(nonempty),
      jobReportPaths: array(header.jobReportPaths).map(nonempty),
    },
    standingOrders: nonempty(value.standingOrders),
    programStore: nonempty(value.programStore),
    state: nonempty(value.state),
    jobs: array(value.jobs).map((input) => {
      const job = strict(input, ["taskId", "reportingTo", "reportPath", "status"]);
      return {
        taskId: nonempty(job.taskId),
        reportingTo: nonempty(job.reportingTo),
        reportPath: nonempty(job.reportPath),
        status: nonempty(job.status),
      };
    }),
  };
  const rendered = `HANDOFF-HEADER v1\n${JSON.stringify(packet.header)}\n`;
  if (Buffer.byteLength(rendered) > 2000) throw new Error("Handoff header exceeds 2000 bytes");
  if (new Set(packet.jobs.map((job) => job.taskId)).size !== packet.jobs.length)
    throw new Error("Duplicate task ids in handoff");
  return { header: rendered, body: `${rendered}\n${JSON.stringify(packet)}` };
}
