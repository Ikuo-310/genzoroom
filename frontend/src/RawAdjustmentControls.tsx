import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import type { AdjustmentId } from './editing';
import type { RawControlId } from './rawApi';
import type { useRawDocument } from './useRawDocument';

const bindings: [string, RawControlId[], AdjustmentId[]][] = [
  ['whiteBalance', ['wb.temp', 'wb.tint'], ['temperature', 'tint']],
  ['basic', ['light.exposure', 'light.contrast', 'light.highlights', 'light.shadows', 'light.whites', 'light.blacks'],
    ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']],
  ['color', ['color.vibrance', 'color.saturation'], ['vibrance', 'saturation']],
];

export function RawAdjustmentControls({ raw }: { raw: NonNullable<ReturnType<typeof useRawDocument>> }) {
  const { t } = useTranslation();
  const settings = raw.settings;
  return <>
    <p className="edit-source-note">{t('workspace.rawPreview.temporary')}</p>
    {raw.pending && !raw.editError && <p role="status">{t('workspace.rawPreview.updating')}</p>}
    {raw.editError && <div role="alert"><p>{t('workspace.rawPreview.editFailed')}</p>
      <button className="tool-button" type="button" onClick={raw.retryControls}>{t('workspace.rawPreview.retry')}</button></div>}
    {settings && bindings.map(([category, controls, ids]) => <section key={category} className="adjustment-category">
      <header className="adjustment-category-header"><h3>{t(`workspace.${category}`)}</h3></header>
      {category === 'whiteBalance' && <p className="edit-source-note">{settings.wb.available
        ? `${settings.wb.mode} · Kelvin` : t('workspace.rawPreview.wbUnavailable')}</p>}
      {controls.map((control, index) => {
        const spec = settings.controls.find(spec => spec.id === control)!;
        const id = ids[index];
        const value = raw.desired?.[control] ?? settings.values[control];
        return <AdjustmentSlider key={`${raw.assetId}:${control}`} adjustmentId={id} actions={false}
          label={t(`workspace.${id}`)} enabled onToggle={() => {}} onReset={() => {}} onBegin={() => {}}
          value={value} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision}
          defaultValue={spec.default} resetLabel="" valueLabel={t(`workspace.${id}Value`)}
          valueText={`${value.toFixed(spec.precision)}${control === 'wb.temp' ? ' K' : control === 'light.exposure' ? ' EV' : ''}`}
          disabled={!!raw.editError || raw.status !== 'ready' || control.startsWith('wb.') && !settings.wb.available}
          onChange={value => raw.changeControls({ [control]: value })} onCommit={raw.flushControls} />;
      })}
    </section>)}
  </>;
}
