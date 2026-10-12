const MAX_ABSOLUTE_CENTS = 999_999_999_999_999_999n;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    if (cents > MAX_ABSOLUTE_CENTS || cents < -MAX_ABSOLUTE_CENTS) {
      throw new RangeError('Monetary amount exceeds allowed precision');
    }
  }

  static from(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(amount)) {
      throw new Error('Invalid monetary amount');
    }

    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid currency');
    }

    const negative = amount.startsWith('-');
    const unsigned = negative ? amount.slice(1) : amount;

    const [units, decimals] = unsigned.split('.');

    if (!units || !decimals) {
      throw new Error('Invalid monetary amount');
    }

    const cents = BigInt(units) * 100n + BigInt(decimals);

    return new Money(negative ? -cents : cents, currency);
  }

  static zero(currency: string): Money {
    return Money.from('0.00', currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents - other.cents, this.currency);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents === other.cents;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents > other.cents;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents < other.cents;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  toString(): string {
    const negative = this.cents < 0n;
    const absolute = negative ? -this.cents : this.cents;

    const units = absolute / 100n;
    const decimals = (absolute % 100n).toString().padStart(2, '0');

    return `${negative ? '-' : ''}${units}.${decimals}`;
  }

  toJSON(): { amount: string; currency: string } {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
