import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretInput } from './secret-input';

function Harness() {
  const [value, setValue] = useState('');
  return <>
    <SecretInput label="Webhook Secret" value={value} onChange={setValue} />
    <button type="button" onClick={() => setValue('')}>Reset</button>
  </>;
}

describe('SecretInput', () => {
  it('uses password-manager ignore attributes and resets cleartext visibility when value clears', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Webhook Secret');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('data-1p-ignore', 'true');
    expect(input).toHaveAttribute('data-lpignore', 'true');

    await user.type(input, 'secret-a');
    await user.click(screen.getByRole('button', { name: '显示秘密' }));
    expect(input).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(input).toHaveAttribute('type', 'password');

    await user.type(input, 'secret-b');
    expect(input).toHaveAttribute('type', 'password');
  });
});
