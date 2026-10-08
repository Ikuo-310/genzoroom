import { useTranslation } from 'react-i18next';
import type { EditStatusFilterMode } from './photoFilters';

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
      <select aria-label={label} value={mode} onChange={event => onChange(event.target.value as EditStatusFilterMode)}>
        <option value="both">{t('photos.allEdits')}</option>
        <option value="edited">{t('photos.editedOnly')}</option>
        <option value="unedited">{t('photos.uneditedOnly')}</option>
      </select>
    </label>
  );
}
