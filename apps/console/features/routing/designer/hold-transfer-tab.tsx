'use client';
import { effectiveHold, routingAudioIds, type RoutingTransferPolicy } from '@winsendotai/ovo-contracts';
import { useMemo } from 'react';
import { ClipManager } from '../../../components/routing/clip-manager';
import { HoldEditor } from '../../../components/routing/hold-editor';
import { HoldTimeline } from '../../../components/routing/hold-timeline';
import { IssueList } from '../../../components/routing/issue-list';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { blankTransfer } from '../../../lib/derive/routing-defaults';
import { useDesigner } from './designer-context';
import { TransferDefaults, TransferTargets } from './transfer-catalogue';

/** Hold, transfer catalogue, point defaults, limits and handover. Inert while transfers are off. */
export function HoldTransferTab({ pointId }: { pointId: string }) {
  const { draft, edit, canEdit, status, audio, index } = useDesigner();
  const transfer = draft.transfer;
  const policy = transfer ?? blankTransfer();
  const setPolicy = (patch: Partial<RoutingTransferPolicy>) =>
    edit((d) => ({ ...d, transfer: { ...(d.transfer ?? blankTransfer()), ...patch } }));
  const durations = useMemo(() => new Map(audio.map((a) => [a.id, a.durationMs / 1000])), [audio]);
  const users = useMemo(
    () => new Map(routingAudioIds(draft).map((id) => [id, [{ id: pointId, name: draft.name }]])),
    [pointId, draft],
  );
  const audioOptions = audio.map((a) => ({ value: a.id, label: a.name }));
  const queueKeys = (draft.humanQueues ?? []).map((b) => b.key);
  const keys = policy.targets.map((t) => t.key);
  return (
    <div className="rt-stack rt-pad">
      {!status.transferEnabled && (
        <InlineAlert tone="warn">
          Transfers are switched off on this installation, so this catalogue and hold are saved but
          inert until they are enabled. A number bound directly to an agent never transfers.
        </InlineAlert>
      )}
      <fieldset className="rt-readonly rt-stack" disabled={!canEdit}>
        <SectionCard
          title="Hold"
          description="What a caller hears while they wait to be connected, for every transfer of this point."
        >
          <IssueList issues={index.bySection.hold} />
          <HoldEditor
            idPrefix="point-hold"
            value={transfer?.hold}
            waitForCapacity
            audio={audioOptions}
            choices={{ queues: queueKeys, targets: keys }}
            offHelp="Off: a built-in hold plays (a short silence, a thank-you line, one minute), then the default agent."
            onChange={(hold) => setPolicy({ hold })}
          />
          <h4>What the caller hears{transfer?.hold ? '' : ' (built-in hold)'}</h4>
          <HoldTimeline policy={effectiveHold(transfer)} clipSeconds={(id) => durations.get(id)} />
        </SectionCard>
        <SectionCard title="Hold clips" description="Upload music or a recording to use in a hold.">
          <ClipManager canEdit={canEdit} users={users} />
        </SectionCard>
        <TransferTargets policy={policy} onChange={setPolicy} />
        <TransferDefaults policy={policy} onChange={setPolicy} />
      </fieldset>
    </div>
  );
}
