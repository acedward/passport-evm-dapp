// What the page says when this browser will not keep MN Bank's records (plan P4-A error states;
// spec edge cases: "storage full or blocked (a private window): the page says so and does not
// register"). One wording per cause, unit-tested.

import type { StorageStatus } from './probe.js';

export function storageText(status: Exclude<StorageStatus, 'ok'>): { title: string; text: string } {
  switch (status) {
    case 'full':
      return {
        title: 'This browser has no room left for MN Bank’s records.',
        text: 'MN Bank keeps your account and its secret only in this browser, so it will not open an account or start anything here until there is room. Free some site data (for example other sites’ storage), then reload this page.',
      };
    case 'unavailable':
      return {
        title: 'This browser has no local storage.',
        text: 'MN Bank keeps your account and its secret only in this browser, so you cannot open or use an account here. Use a browser with local storage turned on.',
      };
    case 'blocked':
      return {
        title: 'This browser is not letting MN Bank keep data.',
        text: 'This happens in a private window, or when site data is blocked. MN Bank keeps your account and its secret only in this browser, so you cannot open or use an account here: open MN Bank in a normal window, or allow site data for it.',
      };
  }
}
