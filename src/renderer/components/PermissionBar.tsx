import React, { useEffect, useState } from 'react';
import type { PermissionRequest } from '../hooks/useAcp';
import { useT } from '../hooks/useLang';

interface PermissionBarProps {
  request: PermissionRequest;
  onRespond: (optionId: string) => Promise<void>;
}

export const PermissionBar: React.FC<PermissionBarProps> = ({
  request,
  onRespond,
}) => {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
  }, [request.requestId]);

  const respond = async (optionId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(optionId);
    } catch (responseError: any) {
      setSubmitting(false);
      setError(responseError?.message || 'Failed to send the permission decision.');
    }
  };

  const allowOnce = request.options.find((option) => option.kind === 'allow_once');
  const allowAlways = request.options.find((option) => option.kind === 'allow_always');
  const reject = request.options.find((option) => option.kind === 'reject_once')
    || request.options.find((option) => option.kind === 'reject_always')
    || request.options.find((option) => option.kind?.startsWith('reject'));

  return (
    <div className="permission-bar" role="region" aria-live="polite" aria-label={t('Tool permission required')}>
      <div className="permission-bar-main">
        <span className="permission-bar-lock" aria-hidden="true">🔐</span>
        <div className="permission-bar-copy">
          <strong>{request.toolTitle || t('Tool permission required')}</strong>
          {request.description && request.description !== request.toolTitle && (
            <code title={request.description}>{request.description}</code>
          )}
        </div>
        <div className="permission-bar-actions">
          {allowOnce && (
            <button disabled={submitting} onClick={() => void respond(allowOnce.optionId)}>
              {`✓ ${t('Allow once')}`}
            </button>
          )}
          {allowAlways && (
            <button disabled={submitting} onClick={() => void respond(allowAlways.optionId)}>
              {`⟲ ${t('Always allow')}`}
            </button>
          )}
          {reject && (
            <button
              className="reject"
              disabled={submitting}
              onClick={() => void respond(reject.optionId)}
            >
              {`⊘ ${t('Reject')}`}
            </button>
          )}
        </div>
      </div>
      {error && <div className="permission-bar-error">⚠ {error} Try again.</div>}
    </div>
  );
};

