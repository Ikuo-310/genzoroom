import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditStatusFilterMode } from './photoFilters';
import { HomeToolbarSelect } from './HomeToolbarSelect';

type EditStatusFilterControlsProps = {
  mode: EditStatusFilterMode;
  onChange: (mode: EditStatusFilterMode) => void;
};

export function EditStatusFilterControls({ mode, onChange }: EditStatusFilterControlsProps) {
  const { t } = useTranslation();
  const selectId = useId();
  const label = t('photos.editFilterLabel');
  const selectedLabel = t(mode === 'both' ? 'photos.allEdits' : mode === 'edited' ? 'photos.editedOnly' : 'photos.uneditedOnly');

  return (
    <div className="home-control edit-status-filter-control">
      <label className="home-control-label" htmlFor={selectId}>{label}</label>
      <HomeToolbarSelect id={selectId} aria-label={label} value={mode} selectedLabel={selectedLabel}
        onChange={event => onChange(event.target.value as EditStatusFilterMode)}>
        <option value="both">{t('photos.allEdits')}</option>
        <option value="edited">{t('photos.editedOnly')}</option>
        <option value="unedited">{t('photos.uneditedOnly')}</option>
      </HomeToolbarSelect>
    </div>
  );
}
