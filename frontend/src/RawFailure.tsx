import { useTranslation } from 'react-i18next';
export function rawFailureCode(cause:unknown){
  const code=typeof cause==='string'?cause:cause && typeof cause==='object' && 'code' in cause?cause.code:undefined;
  return typeof code==='string' && /^[a-z0-9_]{1,80}$/.test(code)?code:'raw_connection_failed';
}
export function RawFailure({code}:{code?:string}){
 const {t}=useTranslation();if(!code)return null;
 const key=code==='raw_session_edit_limit'?'limit':code==='raw_session_regeneration_required'?'regeneration':code==='raw_geometry_recovery_required'?'recovery':'failed';
 return <p className="error-text">{t(`workspace.rawFailure.${key}`)} <code>{code}</code></p>;
}
