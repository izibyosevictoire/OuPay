import { useState } from 'react'
import { CheckboxField } from '@/components/common/CheckboxField'
import { Button } from '@/components/ui/button'
import type { KycApplication, KycDocumentState, KycStorageInfo } from '@/types/kyc'
import { useDeclareDocument } from './kycQueries'

const STATE_TEXT: Record<KycDocumentState, string> = {
  NOT_PROVIDED: 'Not provided',
  DECLARED_READY: 'You say this is ready. OuPay has not received a file.',
  STORED: 'Received and stored privately.',
}

/**
 * Document requirements, tracked honestly. OuPay has no secure storage yet, so a document cannot be uploaded and is never shown as
 * received; the owner can only say it is ready, so it can be asked for later.
 */
export function DocumentsStep({
  application,
  storage,
}: {
  application: KycApplication
  storage: KycStorageInfo
}) {
  const declare = useDeclareDocument()
  const [failure, setFailure] = useState<string | null>(null)
  const documents = application.documents.filter((d) => d.applies)

  const toggle = async (key: string, ready: boolean) => {
    setFailure(null)
    try {
      await declare.mutateAsync({
        applicationId: application.id,
        version: application.version,
        documentKey: key,
        declaredReady: ready,
      })
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : 'That could not be saved.')
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md bg-info-soft px-3 py-2 text-sm text-info" role="note">
        {storage.documentUploadAvailable
          ? 'Upload each document below.'
          : 'Documents cannot be uploaded yet: OuPay has no secure private storage for identity documents. Nothing is received here. You can mark a document as ready so it can be requested when uploading opens, and your application can still be submitted to OuPay.'}
      </p>
      {failure && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {failure}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {documents.map((doc) => (
          <li key={doc.key} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{doc.label}</h3>
              <span className="text-xs text-muted-foreground">
                {doc.required ? 'Required' : 'Optional'}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{STATE_TEXT[doc.state]}</p>
            <CheckboxField
              label={`I have my ${doc.label.toLowerCase()} ready`}
              checked={doc.state === 'DECLARED_READY'}
              disabled={declare.isPending}
              onChange={(event) => void toggle(doc.key, event.target.checked)}
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-describedby={`${doc.key}-upload-note`}
              >
                Upload
              </Button>
              <span id={`${doc.key}-upload-note`} className="ml-2 text-xs text-muted-foreground">
                {storage.documentUploadAvailable ? '' : 'Not available yet'}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
