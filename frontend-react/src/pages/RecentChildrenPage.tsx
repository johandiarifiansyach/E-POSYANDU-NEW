import ReactChildrenTablePage, { type ReactChildrenTablePageProps } from '../features/children/ReactChildrenTablePage';

export type RecentChildrenPageProps = ReactChildrenTablePageProps;

export default function RecentChildrenPage(props: RecentChildrenPageProps) {
  return <ReactChildrenTablePage {...props} initialView="recent" />;
}
