import { useTranslation } from 'react-i18next';
import type { DevelopStatusFilterMode } from './photoFilters';
import { HomeToolbarSelect } from './HomeToolbarSelect';

type DevelopStatusFilterControlsProps = {
  mode: DevelopStatusFilterMode;
  onChange: (mode: DevelopStatusFilterMode) => void;
};

export function DevelopStatusFilterControls({ mode, onChange }: DevelopStatusFilterControlsProps) {
  const { t } = useTranslation();
  const label = t('photos.developStatusFilterLabel');

  return (
    <label className="home-control develop-status-filter-control">
      <span className="home-control-label">{label}</span>
      <HomeToolbarSelect currentLabel={t(mode === 'both' ? 'photos.allDevelopStatuses' : mode === 'developed' ? 'photos.developedOnly' : 'photos.undevelopedOnly')}
        aria-label={label} value={mode} onChange={event => onChange(event.target.value as DevelopStatusFilterMode)}>
        <option value="both">{t('photos.allDevelopStatuses')}</option>
        <option value="developed">{t('photos.developedOnly')}</option>
        <option value="undeveloped">{t('photos.undevelopedOnly')}</option>
      </HomeToolbarSelect>
    </label>
  );
}
