type FilenameParts = { prefix: string; suffix: string };

const SHORT_FILENAME_LIMIT = 20;
const MAX_SUFFIX_LENGTH = 18;
const SUFFIX_SEPARATORS = ['-', '_', ' '];

export function splitFilename(filename: string): FilenameParts {
  if (filename.length <= SHORT_FILENAME_LIMIT) return { prefix: filename, suffix: '' };

  const extensionStart = filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length;
  const extension = filename.slice(extensionStart);
  const suffixBudget = Math.min(MAX_SUFFIX_LENGTH, Math.max(extension.length + 1, Math.floor(filename.length * 0.45)));
  const stemSuffixLength = Math.max(1, suffixBudget - extension.length);
  const earliestStart = Math.max(0, extensionStart - stemSuffixLength);
  const splitIndex = SUFFIX_SEPARATORS.reduce((latest, separator) => {
    const candidate = filename.lastIndexOf(separator, extensionStart - 1);
    return candidate >= earliestStart - 1 ? Math.max(latest, candidate) : latest;
  }, -1);
  const start = splitIndex >= 0 ? splitIndex : earliestStart;

  return { prefix: filename.slice(0, start), suffix: filename.slice(start) };
}

export function FilenameDisplay({ filename }: { filename: string }) {
  const { prefix, suffix } = splitFilename(filename);
  return <span className="filename-middle-ellipsis" title={filename}>
    <span className="filename-middle-ellipsis-visual">
      <span className="filename-prefix">{prefix}</span>
      {suffix && <span className="filename-suffix">{suffix}</span>}
    </span>
  </span>;
}
