import { useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, ShieldCheck, Mail } from "lucide-react";
import { api } from "./client";
import "./legal.css";

const effective = "October 11, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (
    <section className="legal-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function LegalIntro({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <article className="legal-document">
      <header className="legal-heading">
        <p className="page-eyebrow">{eyebrow}</p>
        <h1>
          {title}
          <span className="gold-text">.</span>
        </h1>
        <p>{summary}</p>
        <p className="legal-updated">Effective date: {effective}</p>
        <nav aria-label="Legal information" className="legal-shortcuts">
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/copyright">Copyright &amp; DMCA</a>
          <a href="/privacy#contact-us">Contact Cove</a>
        </nav>
      </header>
      {children}
      <p className="legal-updated">
        Last updated: {effective}. Substantive changes will be reflected here; material changes
        affecting existing users will receive appropriate notice.
      </p>
    </article>
  );
}

type Topic =
  | "privacy-access"
  | "privacy-delete"
  | "privacy-correction"
  | "privacy-choice"
  | "privacy-other"
  | "terms"
  | "other";
export function LegalContactForm() {
  const [category, setCategory] = useState<Topic>("privacy-other");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [website, setWebsite] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setReference("");
    try {
      const response = await api<{ reference: string }>("/legal/contact", "POST", {
        category,
        email,
        message,
        website,
      });
      setReference(response.reference || "");
      setMessage("");
    } catch (error) {
      setError((error as Error).message || "Your message could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="legal-contact-form">
      <div className="legal-contact-title">
        <Mail size={19} />
        <h3>Send a privacy or legal request</h3>
      </div>
      <p>
        Available without an account. Please don't include passwords, full payment-card numbers, or
        other unnecessary sensitive information. This form records your request; it does not
        instantly verify identity or erase records.
      </p>
      <form onSubmit={submit}>
        <label>
          What can we help with?
          <select required value={category} onChange={(e) => setCategory(e.target.value as Topic)}>
            <option value="privacy-access">Access or export my information</option>
            <option value="privacy-delete">Delete my information</option>
            <option value="privacy-correction">Correct my information</option>
            <option value="privacy-choice">Privacy choices or opt-out</option>
            <option value="privacy-other">Other privacy question</option>
            <option value="terms">Terms of Service question</option>
            <option value="other">Other legal request</option>
          </select>
        </label>
        <label>
          Your reply email
          <input
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          Your request
          <textarea
            required
            minLength={15}
            maxLength={4000}
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us which information or right your request concerns."
          />
        </label>
        <div className="legal-bot-field" aria-hidden="true">
          <label>
            Website{" "}
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {reference && (
          <p role="status" className="legal-success">
            <CheckCircle2 size={18} /> Request recorded. Keep reference <strong>{reference}</strong>
            .
          </p>
        )}
        <button type="submit" disabled={busy} className="button gold">
          {busy ? "Sending…" : "Submit request"}
        </button>
      </form>
    </div>
  );
}

export function TermsPage() {
  return (
    <LegalIntro
      eyebrow="COVE · LEGAL"
      title="Terms of Service"
      summary="The rules for using Cove's bookstore, reading tools, and community features."
    >
      <Section title="Agreement and eligibility">
        <p>
          These Terms govern access to the Cove website, reader, audiobook player, library, social
          features, and related digital services (together, “Cove”). By creating an account or using
          Cove, you agree to these Terms and acknowledge our <a href="/privacy">Privacy Policy</a>.
          If you do not agree, do not create an account or use the service.
        </p>
        <p>
          Individuals under 13 may not open a Cove account. If you are a minor where you live, you
          should use Cove only with the permission of a parent or legal guardian where required. We
          may restrict features or access where law requires.
        </p>
      </Section>
      <Section title="Your account and reading data">
        <p>
          Provide accurate sign-up information, verify an email address when asked, protect your
          credentials, and notify us through the contact form below if you suspect account misuse.
          Do not share account access, impersonate another person, or attempt to circumvent security
          controls.
        </p>
        <p>
          Your personal library, reading locations, bookmarks, highlights, notes, saved definitions,
          and reading statistics are associated with your account. You may export supported
          information and request account deletion using the account controls, subject to applicable
          legal retention requirements. Public community contributions and content intentionally
          shared with others are different from private reading records.
        </p>
      </Section>
      <Section title="Ebooks, audiobooks, and territorial rights">
        <p>
          Cove includes free public-domain works, third-party materials, and, where enabled,
          commercial books or audiobooks. Rights can differ by country, edition, format, and
          licensing arrangement. A work available in the United States is not necessarily in the
          public domain elsewhere. You are responsible for using content only where you have a
          lawful right to do so.
        </p>
        <p>
          Cove's software and original interface remain protected. For licensed commercial content,
          purchasing or obtaining access provides the limited personal reading or listening rights
          shown for that edition; it does not transfer copyright. Do not strip rights controls,
          redistribute restricted files, or use Cove to infringe anyone's rights.
        </p>
        <p>
          Availability, prices, taxes, refunds, preorders, subscriptions, and entitlement duration
          (if offered) are governed by the terms shown at checkout and any applicable
          consumer-protection laws. Cove does not guarantee that a particular book, audio version,
          or publisher will remain available forever.
        </p>
      </Section>
      <Section title="Your content and community conduct">
        <p>
          You retain rights to the notes, reviews, annotations, and other original content you
          contribute. You grant Cove a limited license to store, transmit, display, and process that
          material solely to provide the features you request, including synchronization, backups,
          and content you explicitly publish or share. You are responsible for material you choose
          to make public.
        </p>
        <p>
          Do not post unlawful, threatening, harassing, deceptive, or infringing content; distribute
          malware; scrape restricted data; abuse automation; or interfere with the safety and
          operation of the service. We may remove violating material, restrict functionality, or
          suspend accounts as reasonably needed to protect users and comply with law.
        </p>
      </Section>
      <Section title="Availability and changes">
        <p>
          Cove is evolving. We may modify features, correct metadata, maintain servers, or retire
          material. Offline files, synchronized locations, and personal notes may depend on device
          and network availability. We take reasonable measures to maintain service and protect
          data, but no online service can promise uninterrupted access or error-free storage. Back
          up important exported notes.
        </p>
      </Section>
      <Section title="Disclaimers and liability">
        <p>
          To the extent permitted by law, Cove is provided without warranties beyond those expressly
          required by applicable law. Information about books, definitions, statistics,
          recommendations, and automatically produced audio/text alignments is informational and may
          be imperfect. Nothing here excludes liability, remedies, or consumer rights that cannot
          lawfully be excluded.
        </p>
      </Section>
      <Section title="Termination and disputes">
        <p>
          You may stop using Cove and request account deletion. We may restrict accounts for serious
          or repeated violations, fraud, security risks, or legal obligations. Rights and
          obligations that by nature should survive termination may continue as legally permitted.
          We encourage contacting us first to resolve concerns. These Terms do not require private
          arbitration or waive rights to seek lawful remedies.
        </p>
      </Section>
      <Section title="Changes and contact">
        <p>
          We will update the effective date when these Terms change and provide additional notice
          where required. For copyright questions, see our{" "}
          <a href="/copyright">Copyright &amp; DMCA page</a>. For account, privacy, or legal
          concerns, use the contact form in our <a href="/privacy#contact-us">Privacy Policy</a>.
        </p>
      </Section>
    </LegalIntro>
  );
}

export function PrivacyPage() {
  return (
    <LegalIntro
      eyebrow="COVE · YOUR DATA"
      title="Privacy Policy"
      summary="How Cove handles your account, reading activity, personal collection, and privacy choices."
    >
      <div className="legal-highlight">
        <ShieldCheck size={22} />
        <p>
          Your private library, highlights, saved words, and reading activity aren't public profiles
          by default. Sharing a review or community post is a separate choice.
        </p>
      </div>
      <Section title="Who this notice covers">
        <p>
          This notice describes how Cove processes personal information when you browse its site,
          create an account, read or listen, save content, purchase an item where supported, or
          contact us. Cove operates the reading service described here. Specific service providers
          may process information on Cove's behalf.
        </p>
      </Section>
      <Section title="Information we collect">
        <ul>
          <li>
            <strong>Account and security:</strong> email, username, display name, identity-provider
            account identifier, account preferences, verification status, session and security
            events, devices, and optional authenticator or passkey metadata. Password credentials
            are processed by the configured authentication provider, rather than saved in Cove's
            reading database.
          </li>
          <li>
            <strong>Your reading life:</strong> personal libraries and shelves, ebook or audio
            positions, reading and listening sessions, goals and statistics, bookmarks, highlighted
            passages, private notes, saved definitions, ratings, wishlists, and custom uploads.
          </li>
          <li>
            <strong>Shopping and community:</strong> where enabled, orders, entitlements,
            subscription state, billing summaries (such as card brand and last four digits),
            reviews, follows, discussions, and content you choose to publish. Payment processors
            handle full card credentials.
          </li>
          <li>
            <strong>Technical information:</strong> requests, device or browser information,
            approximate location inferred from country/IP, security logs, errors, and cookies needed
            for authentication and preferences.
          </li>
          <li>
            <strong>Contact requests:</strong> the reply address and details you send through our
            privacy and legal contact form.
          </li>
        </ul>
      </Section>
      <Section title="How we use information">
        <p>
          We process information to create and secure accounts, provide digital content and
          purchases, synchronize personal libraries and reading positions, save requested highlights
          and notes, generate reading statistics, support customer requests, prevent abuse and
          fraud, comply with legal obligations, and improve reliability. Where enabled,
          recommendations may use reading and storefront interactions; account controls let you
          manage personalization preferences.
        </p>
      </Section>
      <Section title="Providers and disclosures">
        <p>
          Cove's architecture uses or may use infrastructure and identity services such as
          Cloudflare (database, files, edge requests, hosted speech recognition), Vercel (website
          and server execution), Supabase (account authentication when configured), payment
          providers (when checkout is enabled), email-delivery services, and public content
          catalogs. These services process information relevant to their functions. We may disclose
          information when legally required, for fraud and security response, or as part of a
          properly managed business transition. Community posts, reviews, and deliberately shared
          library items can be visible to others.
        </p>
        <p>
          Cove does not intentionally make private reading notes or individual library histories
          available to advertisers. The site may load necessary third-party resources such as fonts,
          and those providers may receive browser connection data. Advertising or optional analytics
          integrations, if introduced, require updated disclosures and relevant choices.
        </p>
      </Section>
      <Section title="Cookies, personalization, and automated features">
        <p>
          Authentication cookies maintain your signed-in session; local device storage can hold
          reader settings or offline downloads. Operational logs help diagnose problems. You can
          control personalized recommendations, search personalization, and reading-activity
          personalization in your account settings, where available. BioSync uses automated speech
          recognition and EPUB text matching to prepare verified word-to-audio timing; it is not
          intended to profile people or use private reader notes as transcription prompts.
        </p>
      </Section>
      <Section title="Retention and security">
        <p>
          We keep account and personal-reading records while your account is active or as needed to
          provide features you request. Deletion requests may be subject to lawful retention,
          dispute, payment, abuse-prevention, or backup obligations. Operational and contact-request
          records are retained only as necessary for the purposes described. We use access controls,
          secure transport, and account verification, but no transmission or storage system is
          completely risk-free.
        </p>
      </Section>
      <Section title="Your choices and privacy rights">
        <p>
          Where available, you may edit profile information, export your account data, change
          privacy and marketing preferences, manage sessions or devices, and request deletion from{" "}
          <a href="/profile">My account</a>. The private reading room also provides ways to delete
          individual highlights, definitions, and library items. You can submit access, correction,
          deletion, or privacy-choice requests without an account using the form below. We may need
          to verify your identity before acting, and some rights vary by location and legal
          exceptions.
        </p>
        <p>
          We will not treat you adversely for exercising applicable privacy rights. If applicable
          law grants an appeal, restriction, objection, portability, or regulator-complaint right,
          you may exercise it through the appropriate channel. See the Terms for information about
          public contributions and licensed materials.
        </p>
      </Section>
      <Section title="Children and international users">
        <p>
          Cove does not knowingly permit accounts for children under 13. Please contact us if you
          believe a child's information was collected. Content licensing and privacy protections
          vary by jurisdiction; certain international transfers may occur where infrastructure
          providers operate. We handle requests under applicable law.
        </p>
      </Section>
      <Section title="Changes to this policy">
        <p>
          When we change our data practices materially, we will update this notice and provide
          notice where required before new purposes apply. Please check the effective date.
        </p>
      </Section>
      <Section title="Contact us">
        <p>
          Send privacy-rights requests, data questions, and legal inquiries through this form,
          including if you cannot sign into your account. Keep the reference number you receive. We
          may request additional proof before disclosing or changing account information.
        </p>
        <LegalContactForm />
      </Section>
    </LegalIntro>
  );
}
