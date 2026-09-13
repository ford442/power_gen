import { formatNumber } from '../utils/index';

export class TorqueGauge {
  container: HTMLElement;
  innerTorque: number;
  outerTorque: number;
  maxTorque: number;
  decimals: number;
  innerValueEl: HTMLElement | null;
  outerValueEl: HTMLElement | null;
  innerBarEl: HTMLElement | null;
  outerBarEl: HTMLElement | null;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId) as HTMLElement;
    this.innerTorque = 0;
    this.outerTorque = 0;
    this.maxTorque = 50; // N·m
    this.decimals = 1;

    this.render();
    this.innerValueEl = this.container.querySelector('.sci-torque-value[data-ring="inner"]');
    this.outerValueEl = this.container.querySelector('.sci-torque-value[data-ring="outer"]');
    this.innerBarEl = this.container.querySelector('.sci-torque-bar[data-ring="inner"]');
    this.outerBarEl = this.container.querySelector('.sci-torque-bar[data-ring="outer"]');
  }

  render(): void {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Torque (Inner & Outer Rings)</span>
      </div>
      <div class="sci-gauge-container">
        <div class="sci-torque-gauge">
          <div class="sci-torque-ring">
            <span class="sci-torque-label">Inner</span>
            <div class="sci-torque-visual">
              <div class="sci-torque-center"></div>
              <div class="sci-torque-bar left" data-ring="inner" style="width: 0%"></div>
              <div class="sci-torque-bar right" data-ring="inner" style="width: 0%"></div>
            </div>
            <span class="sci-torque-value" data-ring="inner">0.0 N·m</span>
          </div>
          <div class="sci-torque-ring">
            <span class="sci-torque-label">Outer</span>
            <div class="sci-torque-visual">
              <div class="sci-torque-center"></div>
              <div class="sci-torque-bar left" data-ring="outer" style="width: 0%"></div>
              <div class="sci-torque-bar right" data-ring="outer" style="width: 0%"></div>
            </div>
            <span class="sci-torque-value" data-ring="outer">0.0 N·m</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Update torque values
   * @param inner - Inner ring torque in N·m
   * @param outer - Outer ring torque in N·m
   */
  setValues(inner: number, outer: number): void {
    this.innerTorque = inner;
    this.outerTorque = outer;

    this.updateRing('inner', inner);
    this.updateRing('outer', outer);
  }

  updateRing(ring: 'inner' | 'outer', value: number): void {
    const absValue = Math.abs(value);
    const percentage = Math.min((absValue / this.maxTorque) * 50, 50);
    const direction = value >= 0 ? 'right' : 'left';

    const valueEl = this.container.querySelector(`.sci-torque-value[data-ring="${ring}"]`) as HTMLElement;
    const leftBar = this.container.querySelector(`.sci-torque-bar.left[data-ring="${ring}"]`) as HTMLElement;
    const rightBar = this.container.querySelector(`.sci-torque-bar.right[data-ring="${ring}"]`) as HTMLElement;

    valueEl.textContent = formatNumber(value, this.decimals) + ' N·m';

    if (direction === 'left') {
      leftBar.style.width = percentage + '%';
      rightBar.style.width = '0%';
    } else {
      leftBar.style.width = '0%';
      rightBar.style.width = percentage + '%';
    }
  }
}
