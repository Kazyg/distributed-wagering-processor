import { Money } from '../../../src/domain/money/money';
import { describe, expect, test } from 'bun:test';

describe('Money', () => {
  test('should create a valid monetary amount', () => {
    const money = Money.from('100.50', 'BRL');

    expect(money.toString()).toBe('100.50');
    expect(money.currency).toBe('BRL');
  });

  test('should add money without precision errors', () => {
    const first = Money.from('0.10', 'BRL');
    const second = Money.from('0.20', 'BRL');

    expect(first.add(second).toString()).toBe('0.30');
  });

  test('should subtract money correctly', () => {
    const balance = Money.from('100.00', 'BRL');
    const bet = Money.from('80.00', 'BRL');

    expect(balance.subtract(bet).toString()).toBe('20.00');
  });

  test('should detect a negative result', () => {
    const balance = Money.from('50.00', 'BRL');
    const bet = Money.from('80.00', 'BRL');

    const result = balance.subtract(bet);

    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-30.00');
  });

  test('should prevent operations between currencies', () => {
    const brl = Money.from('100.00', 'BRL');
    const usd = Money.from('50.00', 'USD');

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
    expect(() => brl.subtract(usd)).toThrow('Currency mismatch');
    expect(() => brl.isLessThan(usd)).toThrow('Currency mismatch');
  });

  test('should reject invalid monetary amounts', () => {
    const invalidAmounts = ['10', '10.1', '10.123', '10,50', 'NaN', 'Infinity', '1e3', ''];

    for (const amount of invalidAmounts) {
      expect(() => Money.from(amount, 'BRL')).toThrow();
    }
  });

  test('should reject invalid currencies', () => {
    expect(() => Money.from('10.00', 'brl')).toThrow();
    expect(() => Money.from('10.00', 'BR')).toThrow();
  });

  test('should not modify the original amount', () => {
    const original = Money.from('100.00', 'BRL');
    const result = original.subtract(Money.from('30.00', 'BRL'));

    expect(original.toString()).toBe('100.00');
    expect(result.toString()).toBe('70.00');
  });

  test('should reject values beyond database precision', () => {
    const maximum = Money.from('9999999999999999.99', 'BRL');

    expect(() => maximum.add(Money.from('0.01', 'BRL'))).toThrow(RangeError);
  });

  test('should serialize monetary values as strings', () => {
    const money = Money.from('25.50', 'BRL');

    expect(JSON.stringify(money)).toBe('{"amount":"25.50","currency":"BRL"}');
  });
});
