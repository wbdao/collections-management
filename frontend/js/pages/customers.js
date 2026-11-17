/**
 * Customer lookup workspace. Customer master data lives in a separate,
 * daily-updated spreadsheet — it is read-only here and searched by
 * Account, Name and الاسم الموحد through the autocomplete widget.
 */
import { card, kv, statusBadge, empty } from '../components/ui.js';
import { customerAutocomplete, bindCustomerAutocomplete } from '../components/customer-autocomplete.js';

let selected = null;

export default {
  title: 'Customers',
  subtitle: 'Read-only lookup from the external customer master spreadsheet',
  permission: 'customers.read',
  async render() {
    return `
      <div class="stack">
        ${card({
          title: 'Find a customer',
          subtitle: 'Type an account number, English name or Arabic unified name',
          body: `
            <div class="row" style="align-items:flex-end">
              ${customerAutocomplete({ id: 'customer-lookup' })}
            </div>
            <p style="font-size:12px;color:var(--color-ink-faint);margin-top:10px">
              Account is the unique identifier. The master spreadsheet is the system of record.
            </p>`
        })}
        <div id="customer-detail">${selected ? detailCard(selected) : empty('Select a customer to view its master data.')}</div>
      </div>`;
  },
  async mounted(root) {
    const detail = root.querySelector('#customer-detail');
    bindCustomerAutocomplete(root, {
      id: 'customer-lookup',
      onSelect(customer) {
        selected = customer;
        detail.innerHTML = detailCard(customer);
      }
    });
    if (selected && detail) detail.innerHTML = detailCard(selected);
  }
};

function detailCard(customer) {
  if (!customer) return empty('Select a customer to view its master data.');
  const accountStatus = customer.account_status || customer.customer_status || customer.accountStatus || '';
  const rows = [
    ['Account', customer.account],
    ['Name', customer.name],
    ['Warehouse Group', customer.warehouse],
    ['Customer group', customer.department],
    ['Account status', accountStatus],
    ['Arabic unified name (الاسم الموحد)', customer.unifiedName],
    ['Telephone', customer.phone],
    ['ID number', customer.national_id],
    ['Credit limit', customer.creditLimit],
    ['Balance', customer.balance]
  ];
  return card({
    title: `${customer.account} — ${customer.name || 'Unnamed customer'}`,
    subtitle: 'Values are inherited by new receipts, cheques and guarantees',
    body: `
      <div class="row" style="margin-bottom:12px">${statusBadge(accountStatus || 'UNKNOWN')}</div>
      ${kv(rows)}`
  });
}
