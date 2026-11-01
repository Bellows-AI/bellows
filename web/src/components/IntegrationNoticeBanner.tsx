import type { IntegrationNotice } from '../settings/integration-providers.js';
import { Icon } from './Icon.js';

const NOTICE_ICON = { info: 'info', warn: 'alert-triangle', bad: 'alert-circle' } as const;

/** A callback result as a toned banner: success is quiet, a decline or failure is announced. */
export function IntegrationNoticeBanner({ notice }: { notice: IntegrationNotice }) {
    return (
        <div className={`banner-${notice.tone}`} role={notice.tone === 'info' ? undefined : 'alert'}>
            <Icon name={NOTICE_ICON[notice.tone]} size={24} />
            <p>{notice.message}</p>
        </div>
    );
}
