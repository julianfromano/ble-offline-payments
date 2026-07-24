import { BhCard } from '../bh';
import chargeMoney from '../bh/assets/charge-money.svg';
import exchange from '../bh/assets/exchange.svg';
import shieldCheck from '../bh/assets/shield-check.svg';
import success from '../bh/assets/success.svg';

const STEPS = [
  {
    img: chargeMoney,
    title: '1 · El vendedor genera el cobro',
    text: 'Ingresa el monto y la app le muestra un código de 4 dígitos en pantalla.',
  },
  {
    img: exchange,
    title: '2 · El comprador ingresa el código',
    text: 'Los dos celulares se encuentran y se conectan por Bluetooth. No hace falta internet ni datos móviles.',
  },
  {
    img: shieldCheck,
    title: '3 · Conexión protegida',
    text: 'El código crea un canal cifrado entre ambos teléfonos: nadie más puede ver ni modificar la operación.',
  },
  {
    img: success,
    title: '4 · Confirmación en ambas pantallas',
    text: 'El comprador confirma el monto y los dos ven el resultado al instante. El comprobante queda guardado en ambos celulares.',
  },
];

export function HowItWorks() {
  return (
    <div className="steps">
      {STEPS.map((s) => (
        <BhCard key={s.title} orientation="horizontal" className="step-card">
          <div className="step-row">
            <img src={s.img} alt="" className="step-img" />
            <div>
              <p className="bh-card__title">{s.title}</p>
              <p className="step-text">{s.text}</p>
            </div>
          </div>
        </BhCard>
      ))}
      <p className="muted steps-footer">
        Pensado para ferias, transporte, zonas sin señal o cortes de red: la operación
        se registra en los dos teléfonos y se sincroniza con el banco al volver la conexión.
      </p>
    </div>
  );
}
