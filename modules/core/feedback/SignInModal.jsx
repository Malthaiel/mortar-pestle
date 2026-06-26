import { useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { TextInput } from '@host/components/ui/Input.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';

// Email-OTP sign-in: email → 6-digit code → session. Reuses AppWindow + candy
// primitives only. The code email requires custom SMTP on the Supabase project
// (built-in email sends a link, not a code) — a test-time setup step.
export default function SignInModal({ open, onClose, fb, accent, onSignedIn }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setStep('email'); setEmail(''); setCode(''); setError(''); setBusy(false); };
  const close = () => { onClose?.(); reset(); };

  const sendCode = async () => {
    setError(''); setBusy(true);
    try { await fb.otpSend(email.trim()); setStep('code'); }
    catch (e) { setError(e.message || 'Could not send code'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setError(''); setBusy(true);
    try {
      const s = await fb.otpVerify(email.trim(), code.trim());
      onSignedIn?.(s);
      close();
    } catch (e) { setError(e.message || 'Invalid or expired code'); setBusy(false); }
  };

  return (
    <AppWindow open={open} onClose={close} title="Sign in" accent={accent} width={420} height="auto">
      {step === 'email' ? (
        <div style={col}>
          <div style={hint}>Enter your email — we'll send a 6-digit sign-in code.</div>
          <TextInput value={email} onChange={setEmail} placeholder="you@example.com" type="email" accent={accent}
            autoFocus style={{ width: '100%' }}
            onKeyDown={(e) => e.key === 'Enter' && email.trim() && sendCode()} />
          {error && <div style={errStyle}>{error}</div>}
          <PrimaryBtn onClick={sendCode} disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send code'}</PrimaryBtn>
        </div>
      ) : (
        <div style={col}>
          <div style={hint}>Enter the code sent to <b style={{ color: 'var(--text)' }}>{email}</b>.</div>
          <TextInput value={code} onChange={setCode} placeholder="123456" accent={accent}
            autoFocus style={{ width: '100%', letterSpacing: '0.3em', fontSize: 16 }}
            onKeyDown={(e) => e.key === 'Enter' && code.trim() && verify()} />
          {error && <div style={errStyle}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <PrimaryBtn onClick={verify} disabled={busy || !code.trim()}>{busy ? 'Verifying…' : 'Verify'}</PrimaryBtn>
            <OutlinedBtn onClick={() => { setStep('email'); setError(''); }} disabled={busy}>Back</OutlinedBtn>
          </div>
        </div>
      )}
    </AppWindow>
  );
}

const col = { display: 'flex', flexDirection: 'column', gap: 12 };
const hint = { fontSize: 13, color: 'var(--text-muted)' };
const errStyle = { color: 'var(--error)', fontSize: 12 };
