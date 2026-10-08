import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { DevelopStatusFilterMode } from './photoFilters';
import { HomeToolbarSelect } from './HomeToolbarSelect';

type DevelopStatusFilterControlsProps = {
  mode: DevelopStatusFilterMode;
  onChange: (mode: DevelopStatusFilterMode) => void;
};

export function DevelopStatusFilterControls({ mode, onChange }: DevelopStatusFilterControlsProps) {
  const { t } = useTranslation();
  const selectId = useId();
  const label = t('photos.developStatusFilterLabel');
  const selectedLabel = t(mode === 'both' ? 'photos.allDevelopStatuses' : mode === 'developed' ? 'photos.developedOnly' : 'photos.undevelopedOnly');

  return (
    <div className="home-control develop-status-filter-control">
      <label className="home-control-label" htmlFor={selectId}>{label}</label>
      <HomeToolbarSelect id={selectId} aria-label={label} value={mode} selectedLabel={selectedLabel}
        onChange={event => onChange(event.target.value as DevelopStatusFilterMode)}>
        <option value="both">{t('photos.allDevelopStatuses')}</option>
        <option value="developed">{t('photos.developedOnly')}</option>
        <option value="undeveloped">{t('photos.undevelopedOnly')}</option>
      </HomeToolbarSelect>
    </div>
  );
}
