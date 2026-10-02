import { useTranslation } from 'react-i18next';
import type { StackFilterMode } from './photoFilters';

export function StackFilterControls({ mode, onChange }: {
  mode: StackFilterMode;
  onChange: (mode: StackFilterMode) => void;
}) {
  const { t } = useTranslation();
  const label = t('photos.stackFilterLabel');
  return <label className="home-control stack-filter-control">
    <span className="home-control-label">{label}</span>
    <select aria-label={label} value={mode} onChange={event => onChange(event.target.value as StackFilterMode)}>
      <option value="both">{t('photos.allStacks')}</option>
      <option value="stacked">{t('photos.stackedOnly')}</option>
      <option value="unstacked">{t('photos.unstackedOnly')}</option>
    </select>
  </label>;
}
