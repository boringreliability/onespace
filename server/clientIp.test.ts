/**
 * ipKey (R19, lives in server/clientIp.ts): the rate-limit key for a client address.
 * IPv4 as is; IPv4-mapped IPv6 as IPv4; IPv6 collapsed to its /64; garbage to 'unknown'.
 */

import { describe, expect, it } from 'vitest';

import { ipKey } from './clientIp';

describe('ipKey', () => {
  describe('given an IPv4 address', () => {
    it.each([
      ['1.2.3.4', '1.2.3.4'],
      ['255.255.255.255', '255.255.255.255'],
      ['10.0.0.1', '10.0.0.1'],
    ])('when it is %s, then the key is %s', (ip, key) => {
      expect(ipKey(ip)).toBe(key);
    });
  });

  describe('given an IPv4-mapped IPv6 address', () => {
    it.each([
      ['::ffff:1.2.3.4', '1.2.3.4'],
      ['::FFFF:1.2.3.4', '1.2.3.4'],
      ['::Ffff:1.2.3.4', '1.2.3.4'],
    ])('when it is %s, then the key is the IPv4 address %s', (ip, key) => {
      expect(ipKey(ip)).toBe(key);
    });
  });

  describe('given an IPv6 address', () => {
    it.each([
      ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
      ['2001:DB8::1', '2001:db8:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
      ['2001:0db8:0001:0002::', '2001:db8:1:2::/64'],
      ['::', '0:0:0:0::/64'],
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['[2001:db8:1:2::5]', '2001:db8:1:2::/64'],
      ['[2001:DB8::1%en0]', '2001:db8:0:0::/64'],
    ])('when it is %s, then the key is %s', (ip, key) => {
      expect(ipKey(ip)).toBe(key);
    });

    it('when two addresses share the first four hextets, then they get the same key', () => {
      expect(ipKey('2001:db8:1:2::')).toBe(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    });

    it('when the fourth hextet differs, then the key differs', () => {
      expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    });

    it('when the address uses :: in the middle, then it is expanded before taking the prefix', () => {
      expect(ipKey('2001:db8::2:1')).toBe('2001:db8:0:0::/64');
      expect(ipKey('1:2:3::8')).toBe('1:2:3:0::/64');
    });
  });

  describe('given something that is not an address', () => {
    it.each([
      [''],
      ['   '],
      ['garbage'],
      ['999.1.1.1'],
      ['1.2.3'],
      ['1.2.3.4.5'],
      ['2001:db8:1:2:3:4:5:6:7'],
      ['2001:db8::1::2'],
      ['2001:zzzz::1'],
      ['12345::1'],
      [':::'],
      ['::ffff:999.1.1.1'],
      ['unknown'],
    ])('when it is %j, then the key is "unknown"', (ip) => {
      expect(ipKey(ip)).toBe('unknown');
    });
  });
});
