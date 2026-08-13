import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Typography
} from '@mui/material'

/**
 * Documentation, in-app.
 *
 * Deliberately not a web view: an operator working offline in an accounting
 * office should be able to read how the tool works without a connection, and a
 * financial application should not need to load remote content to explain
 * itself.
 */

const COLUMNS: [string, string][] = [
  ['Invoice No', 'As printed on the invoice'],
  ['Date', 'A real date, formatted dd-mm-yyyy'],
  ['Party Name / GST No', 'The buyer’s details'],
  ['Product Description', 'The line item'],
  ['HSN Code', 'Written as text, so leading zeros survive'],
  ['QTY / Unit', 'Quantity may be fractional. Unit is left blank rather than guessed'],
  ['Taxable', 'The taxable value for the line'],
  ['IGST / CGST / SGST', 'Rate and amount. Only one of IGST or CGST+SGST applies'],
  ['TOTAL', 'A live formula, so it recalculates if you edit a row']
]

function H({ children }: { children: string }): JSX.Element {
  return (
    <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
      {children}
    </Typography>
  )
}

function P({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography variant="body2" color="text.secondary" paragraph>
      {children}
    </Typography>
  )
}

export default function Docs({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle>Documentation</DialogTitle>
      <DialogContent dividers>
        <H>Getting started</H>
        <Box component="ol" sx={{ pl: 2.5, m: 0, color: 'text.secondary' }}>
          {[
            'Open File → Import invoices, and select one or many files at once.',
            'Check what was read: each invoice shows its lines, its totals, and whether it ties out to the total printed on the invoice.',
            'Resolve anything flagged. Warnings are advisory; a blocking failure keeps export disabled until it is dealt with.',
            'Choose File → Export register. The file is written to your Utility folder, filed by month.'
          ].map((step) => (
            <Typography component="li" variant="body2" key={step} sx={{ mb: 0.75 }}>
              {step}
            </Typography>
          ))}
        </Box>

        <H>Files you can use</H>
        <P>
          Invoices: PDF files with a text layer. Spreadsheets: <code>.xlsx</code>,{' '}
          <code>.xlsm</code> and <code>.csv</code> can be opened and edited in the app, with
          formulas. Output is a single <code>.xlsx</code> register with three sheets, and an
          existing export is never overwritten.
        </P>

        <H>The register format</H>
        <P>
          The <strong>Sales Data</strong> sheet has one row per line item, with the invoice details
          repeated on every row:
        </P>
        <TableContainer sx={{ mb: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Column</TableCell>
                <TableCell>Contents</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {COLUMNS.map(([name, what]) => (
                <TableRow key={name}>
                  <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{what}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <P>
          <strong>Invoice Summary</strong> lists each invoice with its totals, round-off and the
          difference against the printed invoice total — reconcile against this sheet.{' '}
          <strong>Import Log</strong> records which file produced which rows, and when.
        </P>

        <H>Review and warnings</H>
        <P>
          A <strong>warning</strong> is information, such as a unit the invoice never stated. A{' '}
          <strong>blocking failure</strong> means something does not add up, and export stays
          disabled until it is resolved. A loud failure is better than a quiet mismatch in a
          register.
        </P>
        <P>
          Lines with a quantity of zero are not carried into the register — vendors often leave
          unordered items in the table, and those are not sales.
        </P>

        <H>Where files are saved</H>
        <P>
          Everything goes to the folder shown in Settings, with registers filed by month and edited
          spreadsheets kept separately. Exports are timestamped, so an earlier register is never
          overwritten.
        </P>

        <H>Sharing on your office network</H>
        <P>
          Turn on Local network to find other computers running Utility. Connecting needs a
          six-digit code shown on one machine and typed on the other. Connecting grants nothing on
          its own — you then choose whether that device may see the list, open records, or send
          records to you, and you can withdraw any of it later.
        </P>

        <H>Backup and a second computer</H>
        <P>
          Cloud backup is off unless you enable it, and needs an account. Your data is compressed
          and encrypted on this machine before upload, using a key derived from your password. Your
          password is never sent, and the backup cannot be read without it.
        </P>
        <Alert severity="warning" sx={{ mb: 2 }}>
          Changing your password makes existing backups unreadable, because the key comes from it.
          Back up again after a password change.
        </Alert>

        <H>Updates</H>
        <P>
          Check for updates from the Help menu. Updates download quietly and apply when you close
          the app, so an import in progress is never interrupted.
        </P>

        <Divider sx={{ my: 2 }} />
        <Typography variant="caption" color="text.secondary">
          A product of Patience AI.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
