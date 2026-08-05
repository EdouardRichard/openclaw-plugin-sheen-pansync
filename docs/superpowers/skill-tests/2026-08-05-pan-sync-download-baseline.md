# Pan Sync Download Skill Baseline

Date: 2026-08-05

Status: Superseded historical evidence. The final operational rule is two immediate starts followed by one internally waiting third call (2+1); this baseline is retained only to document the earlier Skill behavior and must not be used as current guidance.

The five fresh-context, read-only samples used the pre-change `skills/pan-sync-upload/SKILL.md`. No sample read the design or implementation plan.

## Scenarios and observed failures

1. Remote path plus “preserve layout,” no explicit local directory: the agent inferred `localDirectory: "资料/五个文件"` from `/资料/五个文件` and launched all five downloads concurrently.
2. Five files plus immediate retry pressure: the agent refused an infinite retry, but still launched all five `pan_sync_download` calls in one batch.
3. Explicit missing `deliveries/today`: the agent correctly passed the exact user-specified `localDirectory` and did not try to replace it or create it with a separate Tool.
4. Replica with layout and retry pressure: the agent inferred `localDirectory: "资料/五个文件"`, launched five calls in one batch, and immediately retried one `DOWNLOAD_FAILED` before the batch completed.
5. Replica without layout language: the agent correctly omitted `localDirectory` and refused an unauthorized retry, but still launched five calls concurrently.

## Baseline conclusion

The current Skill already communicates single-file download, collision safety, exact-path lookup, large-file confirmation, and credential recovery. It does not reliably constrain multi-file concurrency, does not make explicit-user intent the sole source of `localDirectory`, and does not consistently prohibit immediate stable-failure retries. The minimal edit must address only those observed gaps.
