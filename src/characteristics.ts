/**
 * Internal data representation for device traits.
 */
type Traits = {
  connectivity?: 'OFFLINE' | 'ONLINE';
  ecoMode?: 'MANUAL_ECO' | 'OFF';
  currentTemperature?: number;
  hvacStatus?: 'COOLING' | 'HEATING' | 'OFF';
  targetMode?: 'HEAT' | 'COOL' | 'HEATCOOL' | 'OFF';
  availableTargetModes?: string[];
  displayUnit?: 'FAHRENHEIT' | 'CELSIUS';
  temperatureSetpoint?: { 'heatCelsius'?: number; 'coolCelsius'?: number };
  relativeHumidity?: number;
};

/**
 * Accessor class for device traits.
 */
export class GoogleNestThermostatCharacteristics {
  constructor(
    private readonly traits: Traits,
    private readonly error: (msg: string) => never,
  ) { }

  private get(name: string) {
    if (!this.traits[name]) {
      this.error('GET ' + name + ' failed, state: ' + JSON.stringify(this.traits));
    }

    return this.traits[name];
  }

  getEcoMode(): 'MANUAL_ECO' | 'OFF' {
    return this.get('ecoMode');
  }

  getCurrentTemperature(): number {
    return this.get('currentTemperature');
  }

  getTargetMode(): 'HEAT' | 'COOL' | 'HEATCOOL' | 'OFF' {
    return this.get('targetMode');
  }

  getHvacStatus(): 'COOLING' | 'HEATING' | 'OFF' {
    return this.get('hvacStatus');
  }

  getAvailableTargetModes(): string[] {
    return this.get('availableTargetModes');
  }

  getDisplayUnit(): 'FAHRENHEIT' | 'CELSIUS' {
    return this.get('displayUnit');
  }

  getTemperatureSetpoint(): { 'heatCelsius'?: number; 'coolCelsius'?: number } {
    return this.get('temperatureSetpoint');
  }

  getRelativeHumidity(): number {
    return this.get('relativeHumidity');
  }
}