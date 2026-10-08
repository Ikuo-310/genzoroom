import { useTranslation } from 'react-i18next';
import type { EditStatusFilterMode } from './photoFilters';
import { HomeToolbarSelect } from './HomeToolbarSelect';

type EditStatusFilterControlsProps = {
  mode: EditStatusFilterMode;
  onChange: (mode: EditStatusFilterMode) => void;
};

export function EditStatusFilterControls({ mode, onChange }: EditStatusFilterControlsProps) {
  const { t } = useTranslation();
  const label = t('photos.editFilterLabel');

  return (
    <label className="home-control edit-status-filter-control">
      <span className="home-control-label">{label}</span>
      <HomeToolbarSelect currentLabel={t(mode === 'both' ? 'photos.allEdits' : mode === 'edited' ? 'photos.editedOnly' : 'photos.uneditedOnly')}
        aria-label={label} value={mode} onChange={event => onChange(event.target.value as EditStatusFilterMode)}>
        <option value="both">{t('photos.allEdits')}</option>
        <option value="edited">{t('photos.editedOnly')}</option>
        <option value="unedited">{t('photos.uneditedOnly')}</option>
      </HomeToolbarSelect>
    </label>
  );
}
