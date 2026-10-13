import { app } from 'electron'
import { join } from 'node:path'

/**
 * The one folder the app keeps in the user's Documents. Recordings go here because the point of
 * saving them is that you can find them; user plugins go here for the same reason — it is where
 * someone would look for "where do I put my own". Application Support is where nobody looks.
 */
export function documentsDir(): string {
  return join(app.getPath('documents'), 'magiceth')
}
