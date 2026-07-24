import { useState } from 'react';
import { ChargeMode } from './components/ChargeMode';
import { PayMode } from './components/PayMode';
import { HowItWorks } from './components/HowItWorks';
import { Logs } from './components/Logs';
import { BhChip, BhHeader } from './bh';

type Tab = 'cobrar' | 'pagar' | 'como';

export function App() {
  const [tab, setTab] = useState<Tab>('cobrar');

  return (
    <main className="app">
      <BhHeader actions={<BhChip severity="special">Demo</BhChip>} />

      <div className="hero">
        <h1>Pagos sin conexión</h1>
        <p className="muted">
          Cobrá y pagá de celular a celular por Bluetooth, aunque no haya internet.
        </p>
      </div>

      <nav className="tabs" role="tablist" aria-label="Modo">
        <button
          role="tab"
          aria-selected={tab === 'cobrar'}
          aria-controls="panel-cobrar"
          onClick={() => setTab('cobrar')}
        >
          Cobrar
        </button>
        <button
          role="tab"
          aria-selected={tab === 'pagar'}
          aria-controls="panel-pagar"
          onClick={() => setTab('pagar')}
        >
          Pagar
        </button>
        <button
          role="tab"
          aria-selected={tab === 'como'}
          aria-controls="panel-como"
          onClick={() => setTab('como')}
        >
          ¿Cómo funciona?
        </button>
      </nav>

      <section id="panel-cobrar" role="tabpanel" hidden={tab !== 'cobrar'}>
        {tab === 'cobrar' && <ChargeMode />}
      </section>
      <section id="panel-pagar" role="tabpanel" hidden={tab !== 'pagar'}>
        {tab === 'pagar' && <PayMode />}
      </section>
      <section id="panel-como" role="tabpanel" hidden={tab !== 'como'}>
        {tab === 'como' && <HowItWorks />}
      </section>

      <details className="tech-details">
        <summary>Registro técnico</summary>
        <Logs />
      </details>
    </main>
  );
}
