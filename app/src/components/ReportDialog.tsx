import { useState } from 'react';
import { addReport } from '../db';
import { REPORT_REASONS, type Card } from '../types';
import { cardTitle } from './CardImages';

/** 「この問題を報告」ダイアログ */
export function ReportDialog({ card, onClose }: { card: Card; onClose: (msg?: string) => void }) {
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const sent = await addReport(card, reason, memo.trim());
    onClose(sent == null ? '報告を保存しました（Mac につないだときに送ります）' : '報告を Mac に送りました');
  };

  return (
    <div className="modal-bg" onClick={() => onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>この問題を報告</h2>
        <p className="muted">{cardTitle(card)}</p>
        <div className="reasons">
          {REPORT_REASONS.map((r) => (
            <label key={r} className={r === reason ? 'on' : ''}>
              <input type="radio" name="reason" checked={r === reason} onChange={() => setReason(r)} />
              {r}
            </label>
          ))}
        </div>
        <textarea placeholder="メモ（任意）例: 問3と問4がまとまっている" value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
        <div className="row end">
          <button onClick={() => onClose()}>やめる</button>
          <button className="primary" disabled={busy} onClick={submit}>報告する</button>
        </div>
      </div>
    </div>
  );
}
