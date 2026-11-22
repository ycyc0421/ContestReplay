import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Field, Input } from './fields';

export function SecretInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);
  const shown = visible && value.length > 0;
  return <Field label={label} hint="只写入，保存后不可查看"><div className="relative"><Input aria-label={label} type={shown ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-bwignore="true" value={value} onChange={event => onChange(event.target.value)} className="pr-10 font-mono" />
    <button type="button" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" aria-label={shown ? '隐藏秘密' : '显示秘密'} onClick={() => setVisible(current => !current)}>{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></Field>;
}
