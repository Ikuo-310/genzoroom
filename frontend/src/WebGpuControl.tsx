import { useTranslation } from 'react-i18next';
import type { GpuAvailability } from './useWorkspaceGpu';

export function WebGpuControl({ enabled, availability, active, onChange }: {
  enabled: boolean; availability: GpuAvailability; active: boolean; onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const status = availability === 'available' ? (enabled ? active ? 'active' : 'ready' : 'off') : availability;
  return <div className="webgpu-control">
    <span id="webgpu-status" role="status">{t(`webgpu.${status}`)}</span>
    <button type="button" className="webgpu-switch" role="switch" aria-label={t('webgpu.toggle')}
      aria-checked={enabled} disabled={availability !== 'available'} aria-describedby="webgpu-status"
      onClick={() => onChange(!enabled)}>
      <span className="webgpu-switch-on">{t('settings.on')}</span>
      <span className="webgpu-switch-off">{t('settings.off')}</span>
    </button>
  </div>;
}
