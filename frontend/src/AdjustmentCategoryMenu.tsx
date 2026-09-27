import { useTranslation } from 'react-i18next';
import { AdjustmentContextMenu, type AdjustmentMenuPosition } from './AdjustmentContextMenu';
import type { AdjustmentCategoryId } from './adjustmentSelection';

export type AdjustmentCategoryMenuTarget = AdjustmentMenuPosition & { categoryId: AdjustmentCategoryId };

export function AdjustmentCategoryMenu({ enableLabel, disableLabel, resetLabel, copyLabel, pasteLabel, ...props }: {
  target: AdjustmentCategoryMenuTarget; enabled: boolean; resetDisabled: boolean; pasteDisabled: boolean;
  enableLabel: string; disableLabel: string; resetLabel: string; copyLabel: string; pasteLabel: string;
  onToggle: () => void; onReset: () => void; onCopy: () => void; onPaste: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  return <AdjustmentContextMenu {...props} menuLabel={t('workspace.categoryMenu')}
    className="adjustment-category-context-menu" enableLabel={t(enableLabel)} disableLabel={t(disableLabel)}
    resetLabel={t(resetLabel)} copyLabel={t(copyLabel)} pasteLabel={t(pasteLabel)} />;
}
