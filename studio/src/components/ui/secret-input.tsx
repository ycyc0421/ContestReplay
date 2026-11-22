import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Field, Input } from './fields';

export function SecretInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [visible, setVisible] = useState(false);
  return <Field label={label} hint="只写入，保存后不可查看"><div className="relative"><Input aria-label={label} type={visible ? 'text' : 'password'} autoComplete="off" value={value} onChange={event => onChange(event.target.value)} className="pr-10 font-mono" />
    <button type="button" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground" aria-label={visible ? '隐藏秘密' : '显示秘密'} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></Field>;
}
