import { describe, it, expect } from 'vitest';
import {
  snakeCaseToLabel,
  buildLabelMap,
  buildReverseLabelMap,
  formatResponseRows,
  friendlyType,
} from '@calame/core';

describe('serve response mode integration', () => {
  describe('label mapping for typical database columns', () => {
    it('should generate readable labels for common column patterns', () => {
      const columns = [
        { name: 'first_name' },
        { name: 'last_name' },
        { name: 'email' },
        { name: 'created_at' },
        { name: 'is_active' },
        { name: 'postal_code' },
      ];
      const labelMap = buildLabelMap(columns);
      expect(labelMap['first_name']).toBe('First Name');
      expect(labelMap['last_name']).toBe('Last Name');
      expect(labelMap['email']).toBe('Email');
      expect(labelMap['created_at']).toBe('Created At');
      expect(labelMap['is_active']).toBe('Is Active');
      expect(labelMap['postal_code']).toBe('Postal Code');
    });

    it('should produce a working reverse map for input resolution', () => {
      const columns = [{ name: 'first_name' }, { name: 'last_name' }, { name: 'email' }];
      const labelMap = buildLabelMap(columns);
      const reverseMap = buildReverseLabelMap(labelMap);

      expect(reverseMap['First Name']).toBe('first_name');
      expect(reverseMap['Last Name']).toBe('last_name');
      expect(reverseMap['Email']).toBe('email');
    });

    it('snakeCaseToLabel should be consistent with buildLabelMap output', () => {
      const columns = [{ name: 'order_total' }, { name: 'customer_id' }];
      const labelMap = buildLabelMap(columns);
      expect(labelMap['order_total']).toBe(snakeCaseToLabel('order_total'));
      expect(labelMap['customer_id']).toBe(snakeCaseToLabel('customer_id'));
    });
  });

  describe('response row formatting', () => {
    const labelMap = buildLabelMap([
      { name: 'first_name' },
      { name: 'last_name' },
      { name: 'email' },
      { name: 'role' },
    ]);

    it('should rename keys in friendly mode', () => {
      const rows = [{ first_name: 'John', last_name: 'Doe', email: 'john@test.com', role: 'admin' }];
      const result = formatResponseRows(rows, labelMap, 'friendly');
      expect(result[0]).toEqual({
        'First Name': 'John',
        'Last Name': 'Doe',
        Email: 'john@test.com',
        Role: 'admin',
      });
    });

    it('should pass through unchanged in raw mode', () => {
      const rows = [{ first_name: 'John', last_name: 'Doe' }];
      const result = formatResponseRows(rows, labelMap, 'raw');
      expect(result[0]).toEqual({ first_name: 'John', last_name: 'Doe' });
      expect(result).toBe(rows); // same reference, zero allocation
    });

    it('should handle multiple rows', () => {
      const rows = [
        { first_name: 'John', role: 'admin' },
        { first_name: 'Jane', role: 'user' },
      ];
      const result = formatResponseRows(rows, labelMap, 'friendly');
      expect(result).toHaveLength(2);
      expect(result[0]['First Name']).toBe('John');
      expect(result[1]['First Name']).toBe('Jane');
    });

    it('should handle empty rows', () => {
      const result = formatResponseRows([], labelMap, 'friendly');
      expect(result).toEqual([]);
    });

    it('should preserve keys not in the label map', () => {
      const rows = [{ first_name: 'John', unknown_col: 'value' }];
      const result = formatResponseRows(rows, labelMap, 'friendly');
      expect(result[0]['First Name']).toBe('John');
      expect(result[0]['unknown_col']).toBe('value');
    });
  });

  describe('friendly type translation', () => {
    it('should translate common SQL types', () => {
      expect(friendlyType('integer')).toBe('Nombre');
      expect(friendlyType('bigint')).toBe('Nombre');
      expect(friendlyType('numeric')).toBe('Nombre');
      expect(friendlyType('text')).toBe('Texte');
      expect(friendlyType('varchar')).toBe('Texte');
      expect(friendlyType('boolean')).toBe('Oui/Non');
      expect(friendlyType('timestamp')).toBe('Date');
      expect(friendlyType('date')).toBe('Date');
      expect(friendlyType('jsonb')).toBe('Donnees');
    });

    it('should default to Texte for unknown types', () => {
      expect(friendlyType('uuid')).toBe('Texte');
      expect(friendlyType('inet')).toBe('Texte');
      expect(friendlyType('custom_type')).toBe('Texte');
    });
  });
});
